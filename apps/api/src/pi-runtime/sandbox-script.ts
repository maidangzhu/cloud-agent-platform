export const PI_RUNTIME_SANDBOX_SCRIPT = `
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type, createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const configFile = process.env.CAP_PI_RUNTIME_CONFIG_FILE || "pi-runtime-config.json";
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
const startedAt = Date.now();
let seq = 1;
const writtenFiles = [];
let completedArtifactCount = 0;
let latestArtifact = null;
let latestAssistantContent = "";

const forbiddenEnvKeys = [
  "DATABASE_URL",
  "DIRECT_URL",
  "BETTER_AUTH_SECRET",
  "RUN_TOKEN_SECRET",
  "OPENAI_API_KEY",
  "EXA_API_KEY",
  "REDIS_URL",
];
const MAX_FILE_READ_BYTES = 120000;
const MAX_LIST_ENTRIES = 200;
const MAX_COMMAND_OUTPUT_CHARS = 20000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120000;
const FETCH_URL_TIMEOUT_MS = 15000;
const FETCH_URL_MAX_BYTES = 5 * 1024 * 1024;

function jsonHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer " + config.runToken,
  };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ runId: config.runId, ...body }),
  });
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok || parsed.code !== 0) {
    throw new Error(url + " -> " + response.status + " " + (parsed.message || "request failed"));
  }
  return parsed.data || {};
}

async function postRunEvent(type, payload, extra = {}) {
  const eventSeq = seq++;
  await postJson(config.ingestUrl + "/events", {
    seq: eventSeq,
    type,
    payload,
    ...extra,
  });
  return eventSeq;
}

async function postHeartbeat(phase) {
  return postJson(config.ingestUrl + "/heartbeat", {
    status: "running",
    phase,
  });
}

async function getControl() {
  const response = await fetch(config.controlUrl, {
    method: "GET",
    headers: { Authorization: "Bearer " + config.runToken },
  });
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok || parsed.code !== 0) {
    throw new Error(config.controlUrl + " -> " + response.status + " " + (parsed.message || "request failed"));
  }
  return parsed.data || {};
}

async function stopIfCancelled() {
  const control = await getControl();
  if (control.cancelRequested === true) {
    await postRunEvent("run_cancelled", null);
    return true;
  }
  return false;
}

async function postToolCall(input) {
  return postJson(config.ingestUrl + "/tool-calls", input);
}

async function callSearchProxy(input) {
  return postJson(config.searchProxyUrl, {
    query: input.query,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    provider: config.searchProvider || "fake",
  });
}

async function runTrackedTool(toolCallId, name, args, run) {
  const startedEventSeq = seq++;
  await postToolCall({
    id: toolCallId,
    eventSeq: startedEventSeq,
    name,
    status: "running",
    args,
  });
  try {
    const result = await run(seq++);
    await postToolCall({
      id: toolCallId,
      eventSeq: seq++,
      name,
      status: "completed",
      args,
      result: result.details,
      completedAt: new Date().toISOString(),
    });
    return result;
  } catch (error) {
    await postToolCall({
      id: toolCallId,
      eventSeq: seq++,
      name,
      status: error instanceof RuntimeToolError ? error.status : "failed",
      args,
      error: error instanceof Error ? error.message : String(error),
      completedAt: new Date().toISOString(),
    });
    throw error;
  }
}

class RuntimeToolError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "RuntimeToolError";
    this.status = status;
  }
}

function sha256(value) {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function textResult(text, details, terminate = false) {
  return {
    content: [{ type: "text", text }],
    details,
    ...(terminate ? { terminate: true } : {}),
  };
}

function ensureWorkspaceRoot() {
  fs.mkdirSync(config.workspaceRoot, { recursive: true });
}

function resolveWorkspacePath(inputPath) {
  const rawPath = String(inputPath || ".").trim();
  if (!rawPath || rawPath.includes("\\0")) {
    throw new Error("path is required");
  }
  if (path.isAbsolute(rawPath)) {
    throw new Error("absolute paths are not allowed");
  }
  const normalized = path.normalize(rawPath).replace(/^\\.\\//, "");
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("path must stay inside workspace");
  }
  const absolute = path.resolve(config.workspaceRoot, normalized || ".");
  const root = path.resolve(config.workspaceRoot);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new Error("path must stay inside workspace");
  }
  return { relative: normalized || ".", absolute };
}

function truncateText(value, maxLength = MAX_COMMAND_OUTPUT_CHARS) {
  if (value.length <= maxLength) return { text: value, truncated: false };
  return { text: value.slice(0, maxLength), truncated: true };
}

function stripIpBrackets(host) {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function isBlockedIpAddress(address) {
  const host = stripIpBrackets(String(address).toLowerCase());
  const version = isIP(host);
  if (version === 4) {
    const parts = host.split(".").map(Number);
    const a = parts[0];
    const b = parts[1];
    return parts.length !== 4 || parts.some((part) => !Number.isInteger(part)) ||
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (version === 6) {
    return host === "::1" || host === "::" || host.startsWith("fe80:") ||
      host.startsWith("fc") || host.startsWith("fd") ||
      host.startsWith("::ffff:127.") || host.startsWith("::ffff:10.") ||
      host.startsWith("::ffff:192.168.") || host.startsWith("::ffff:169.254.");
  }
  return true;
}

async function validateFetchTarget(value) {
  if (config.toolPolicy?.allowNetwork !== true) {
    throw new RuntimeToolError("fetch_url is disabled by policy", "rejected");
  }
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new RuntimeToolError("fetch_url URL is invalid", "rejected");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RuntimeToolError("fetch_url only allows http/https URLs", "rejected");
  }
  const host = stripIpBrackets(url.hostname.toLowerCase());
  if (host === "localhost" || host.endsWith(".localhost") ||
      host === "metadata" || host === "metadata.google.internal") {
    throw new RuntimeToolError("SSRF guard rejected host", "rejected");
  }
  if (isIP(host)) {
    if (isBlockedIpAddress(host)) {
      throw new RuntimeToolError("SSRF guard rejected private address", "rejected");
    }
  } else {
    const addresses = await lookup(host, { all: true });
    const blocked = addresses.find((entry) => isBlockedIpAddress(entry.address));
    if (blocked) {
      throw new RuntimeToolError(
        "SSRF guard rejected resolved private address " + blocked.address,
        "rejected",
      );
    }
  }
  return url;
}

function isTextContentType(contentType) {
  if (!contentType) return false;
  const type = contentType.toLowerCase().split(";")[0].trim();
  return type.startsWith("text/") || type === "application/json" ||
    type === "application/xml" || type === "application/xhtml+xml" ||
    type.endsWith("+json") || type.endsWith("+xml");
}

async function fetchPublicUrl(url, signal, redirectCount = 0) {
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "*/*" },
    redirect: "manual",
    signal,
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error("fetch_url redirect is missing location");
    if (redirectCount >= 5) throw new Error("fetch_url exceeded redirect limit");
    const nextUrl = await validateFetchTarget(new URL(location, url).toString());
    return fetchPublicUrl(nextUrl, signal, redirectCount + 1);
  }
  return { response, url };
}

async function fetchUrl(params) {
  let lastError = "fetch_url failed";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error("fetch_url timeout after " + FETCH_URL_TIMEOUT_MS + "ms"));
    }, FETCH_URL_TIMEOUT_MS);
    try {
      const url = await validateFetchTarget(params.url);
      const fetched = await fetchPublicUrl(url, controller.signal);
      const response = fetched.response;
      if (response.status >= 400 && response.status < 500) {
        throw new RuntimeToolError(
          "fetch_url received non-retryable status " + response.status,
          "rejected",
        );
      }
      if (response.status >= 500) {
        throw new Error("fetch_url received retryable status " + response.status);
      }
      const contentType = response.headers.get("content-type") || undefined;
      const full = new Uint8Array(await response.arrayBuffer());
      const truncated = full.byteLength > FETCH_URL_MAX_BYTES;
      const kept = truncated ? full.slice(0, FETCH_URL_MAX_BYTES) : full;
      const text = isTextContentType(contentType)
        ? new TextDecoder().decode(kept)
        : undefined;
      const titleMatch = text ? text.match(/<title[^>]*>([\\s\\S]*?)<\\/title>/i) : null;
      return {
        url: fetched.url.toString(),
        statusCode: response.status,
        ...(contentType ? { contentType } : {}),
        ...(text ? {
          text,
          ...(titleMatch?.[1] ? { title: titleMatch[1].replace(/\\s+/g, " ").trim() } : {}),
        } : {}),
        contentHash: sha256(kept),
        size: full.byteLength,
        truncated,
      };
    } catch (error) {
      if (error instanceof RuntimeToolError) throw error;
      lastError = controller.signal.aborted
        ? "fetch_url timeout after " + FETCH_URL_TIMEOUT_MS + "ms"
        : (error instanceof Error ? error.message : String(error));
      if (attempt === 2) throw new RuntimeToolError(lastError, "failed");
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new RuntimeToolError(lastError, "failed");
}

function safeCommandEnv() {
  const env = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TMPDIR", "CI"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.HOME = config.workspaceRoot;
  env.npm_config_cache = path.join(config.workspaceRoot, ".npm");
  env.npm_config_yes = "true";
  return env;
}

function assertCommandAllowed(command) {
  if (config.toolPolicy?.allowRunCommand !== true) {
    throw new Error("run_command is disabled by policy");
  }
  const normalized = String(command || "").trim();
  if (!normalized) throw new Error("command is required");
  const lower = normalized.toLowerCase();
  const denyCommands = Array.isArray(config.toolPolicy?.denyCommands)
    ? config.toolPolicy.denyCommands
    : [];
  for (const denied of denyCommands) {
    if (denied && lower.includes(String(denied).toLowerCase())) {
      throw new Error("command rejected by policy: " + denied);
    }
  }
  if (
    lower.includes(":(){") ||
    lower.includes("mkfs") ||
    lower.includes("shutdown") ||
    lower.includes("reboot") ||
    lower.includes("> /dev/") ||
    lower.includes(" /etc/") ||
    lower.includes(" /root/")
  ) {
    throw new Error("command rejected by policy");
  }
  return normalized;
}

function runBashCommand(command, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    const child = spawn("bash", ["-lc", command], {
      cwd: config.workspaceRoot,
      env: safeCommandEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      const next = truncateText(stdout + chunk.toString("utf8"));
      stdout = next.text;
      stdoutTruncated = stdoutTruncated || next.truncated;
    });
    child.stderr.on("data", (chunk) => {
      const next = truncateText(stderr + chunk.toString("utf8"));
      stderr = next.text;
      stderrTruncated = stderrTruncated || next.truncated;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        command,
        exitCode: null,
        stdout,
        stderr: stderr || error.message,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        stdoutTruncated,
        stderrTruncated,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        exitCode: code,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdoutTruncated,
        stderrTruncated,
      });
    });
    timer.unref();
  });
}

const tools = [
  {
    name: "read_file",
    label: "Read file",
    description: "Read a UTF-8 text file from the sandbox workspace.",
    parameters: Type.Object({
      path: Type.String(),
    }),
    execute: async (toolCallId, params) => runTrackedTool(toolCallId, "read_file", params, async () => {
      ensureWorkspaceRoot();
      const resolved = resolveWorkspacePath(params.path);
      const stat = fs.statSync(resolved.absolute);
      if (!stat.isFile()) throw new Error("path is not a file");
      const content = fs.readFileSync(resolved.absolute, "utf8");
      const truncated = byteLength(content) > MAX_FILE_READ_BYTES;
      const kept = truncated
        ? Buffer.from(content, "utf8").subarray(0, MAX_FILE_READ_BYTES).toString("utf8")
        : content;
      const details = {
        path: resolved.relative,
        content: kept,
        size: stat.size,
        truncated,
      };
      return textResult(kept || "(empty file)", details);
    }),
  },
  {
    name: "list_directory",
    label: "List directory",
    description: "List files and directories under a sandbox workspace directory.",
    parameters: Type.Object({
      path: Type.Optional(Type.String()),
    }),
    execute: async (toolCallId, params) => runTrackedTool(toolCallId, "list_directory", params, async () => {
      ensureWorkspaceRoot();
      const resolved = resolveWorkspacePath(params.path || ".");
      const entries = fs.readdirSync(resolved.absolute, { withFileTypes: true })
        .slice(0, MAX_LIST_ENTRIES)
        .map((entry) => {
          const childPath = path.join(resolved.absolute, entry.name);
          const stat = fs.statSync(childPath);
          return {
            name: entry.name,
            path: path.relative(config.workspaceRoot, childPath) || ".",
            kind: entry.isDirectory() ? "directory" : "file",
            size: entry.isDirectory() ? 0 : stat.size,
          };
        });
      const details = {
        path: resolved.relative,
        entries,
        truncated: entries.length >= MAX_LIST_ENTRIES,
      };
      return textResult(JSON.stringify(entries, null, 2), details);
    }),
  },
  {
    name: "list_files",
    label: "List files",
    description: "Alias for list_directory.",
    parameters: Type.Object({
      path: Type.Optional(Type.String()),
    }),
    execute: async (toolCallId, params) => runTrackedTool(toolCallId, "list_files", params, async () => {
      ensureWorkspaceRoot();
      const resolved = resolveWorkspacePath(params.path || ".");
      const entries = fs.readdirSync(resolved.absolute, { withFileTypes: true })
        .slice(0, MAX_LIST_ENTRIES)
        .map((entry) => {
          const childPath = path.join(resolved.absolute, entry.name);
          const stat = fs.statSync(childPath);
          return {
            name: entry.name,
            path: path.relative(config.workspaceRoot, childPath) || ".",
            kind: entry.isDirectory() ? "directory" : "file",
            size: entry.isDirectory() ? 0 : stat.size,
          };
        });
      const details = {
        path: resolved.relative,
        entries,
        truncated: entries.length >= MAX_LIST_ENTRIES,
      };
      return textResult(JSON.stringify(entries, null, 2), details);
    }),
  },
  {
    name: "web_search",
    label: "Web search",
    description: "Search the web through the hosted Control Plane search proxy.",
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number()),
    }),
    execute: async (toolCallId, params) => runTrackedTool(toolCallId, "web_search", params, async () => {
      const data = await callSearchProxy({
        query: params.query,
        limit: params.limit,
      });
      return textResult(JSON.stringify(data.results || []), data);
    }),
  },
  {
    name: "fetch_url",
    label: "Fetch URL",
    description: "Fetch and clean a public URL directly from the sandbox with SSRF protection.",
    parameters: Type.Object({
      url: Type.String(),
    }),
    execute: async (toolCallId, params) => runTrackedTool(toolCallId, "fetch_url", params, async (eventSeq) => {
      const result = await fetchUrl(params);
      await postJson(config.ingestUrl + "/sources", {
        kind: "url",
        uri: result.url,
        ...(result.title ? { title: result.title } : {}),
        contentHash: result.contentHash,
        metadata: {
          statusCode: result.statusCode,
          contentType: result.contentType,
          truncated: result.truncated,
          size: result.size,
        },
        eventSeq,
      });
      return textResult(result.text || "Fetched " + result.url, {
        status: "completed",
        result,
      });
    }),
  },
  {
    name: "write_file",
    label: "Write file",
    description: "Write a UTF-8 text file under the sandbox workspace and persist it through hosted ingest APIs.",
    parameters: Type.Object({
      path: Type.String(),
      content: Type.String(),
      mimeType: Type.Optional(Type.String()),
    }),
    execute: async (toolCallId, params) => runTrackedTool(toolCallId, "write_file", params, async (eventSeq) => {
      ensureWorkspaceRoot();
      const resolved = resolveWorkspacePath(params.path);
      fs.mkdirSync(path.dirname(resolved.absolute), { recursive: true });
      fs.writeFileSync(resolved.absolute, params.content, "utf8");
      const contentHash = sha256(params.content);
      const fileData = await postJson(config.ingestUrl + "/files", {
        path: resolved.relative,
        kind: "text",
        mimeType: params.mimeType || "text/markdown",
        size: byteLength(params.content),
        contentHash,
        content: params.content,
      });
      const file = fileData.file || {};
      await postJson(config.ingestUrl + "/events", {
        seq: eventSeq,
        type: "file_written",
        payload: {
          fileId: file.id || params.path,
          path: file.path || resolved.relative,
          size: typeof file.size === "number" ? file.size : byteLength(params.content),
          contentHash: file.contentHash || contentHash,
        },
      });
      if (completedArtifactCount === 0) {
        const artifactTitle = (file.path || resolved.relative).split("/").pop() || (file.path || resolved.relative);
        const artifactEventSeq = seq++;
        await postJson(config.ingestUrl + "/artifacts", {
          title: artifactTitle,
          kind: "text",
          path: file.path || resolved.relative,
          contentSnapshot: params.content,
          eventSeq: artifactEventSeq,
        });
        latestArtifact = {
          title: artifactTitle,
          kind: "text",
          path: file.path || resolved.relative,
        };
        completedArtifactCount += 1;
      }
      writtenFiles.push({
        path: file.path || resolved.relative,
        content: params.content,
      });
      return textResult("Wrote " + (file.path || resolved.relative), file, true);
    }),
  },
  {
    name: "run_command",
    label: "Run command",
    description: "Run a bash command inside the sandbox workspace with timeout, denylist, and output truncation.",
    parameters: Type.Object({
      command: Type.String(),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    execute: async (toolCallId, params) => runTrackedTool(toolCallId, "run_command", params, async () => {
      ensureWorkspaceRoot();
      const command = assertCommandAllowed(params.command);
      const timeoutMs = Math.min(
        Math.max(Number(params.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS), 1000),
        Math.max(Number(config.maxDurationSec || 120) * 1000, 1000),
      );
      const details = await runBashCommand(command, timeoutMs);
      const output = [
        "$ " + command,
        details.stdout ? details.stdout : "",
        details.stderr ? details.stderr : "",
        details.timedOut ? "(command timed out)" : "",
        details.exitCode === 0 ? "" : "(exit code " + details.exitCode + ")",
      ].filter(Boolean).join("\\n");
      return textResult(output || "(no output)", details);
    }),
  },
  {
    name: "create_artifact",
    label: "Create artifact",
    description: "Create or update a workspace artifact through hosted ingest APIs. Use kind text, code, sheet, or image.",
    parameters: Type.Object({
      title: Type.String(),
      kind: Type.Enum(["text", "code", "sheet", "image"]),
      path: Type.Optional(Type.String()),
      contentSnapshot: Type.Optional(Type.String()),
      storageKey: Type.Optional(Type.String()),
      artifactId: Type.Optional(Type.String()),
    }),
    execute: async (toolCallId, params) => runTrackedTool(toolCallId, "create_artifact", params, async (eventSeq) => {
      if (completedArtifactCount > 0) {
        return textResult(
          "Artifact already exists for this run",
          latestArtifact || params,
          true,
        );
      }
      const artifactData = await postJson(config.ingestUrl + "/artifacts", {
        ...(params.artifactId ? { artifactId: params.artifactId } : {}),
        title: params.title,
        kind: params.kind,
        ...(params.path ? { path: params.path } : {}),
        ...(params.contentSnapshot ? { contentSnapshot: params.contentSnapshot } : {}),
        ...(params.storageKey ? { storageKey: params.storageKey } : {}),
        eventSeq,
      });
      const artifact = artifactData.artifact || {};
      latestArtifact = artifact;
      completedArtifactCount += 1;
      return textResult("Created artifact " + (artifact.title || params.title), artifact, true);
    }),
  },
];

async function ensureArtifactsForWrittenFiles() {
  if (completedArtifactCount > 0 || writtenFiles.length === 0) return;
  for (const [index, file] of writtenFiles.entries()) {
    const title = file.path.split("/").pop() || file.path;
    await runTrackedTool(
      "runtime-create-artifact-" + (index + 1),
      "create_artifact",
      {
        title,
        kind: "text",
        path: file.path,
        contentSnapshot: file.content,
      },
      async (eventSeq) => {
        const artifactData = await postJson(config.ingestUrl + "/artifacts", {
          title,
          kind: "text",
          path: file.path,
          contentSnapshot: file.content,
          eventSeq,
        });
        const artifact = artifactData.artifact || {};
        latestArtifact = artifact;
        completedArtifactCount += 1;
        return textResult("Created artifact " + (artifact.title || title), artifact, true);
      },
    );
  }
}

function toLlmMessages(context) {
  const messages = [];
  if (context.systemPrompt) {
    messages.push({ role: "system", content: context.systemPrompt });
  }
  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: stringifyContent(message.content) });
    }
    if (message.role === "assistant") {
      messages.push({ role: "assistant", content: stringifyContent(message.content) });
    }
    if (message.role === "toolResult") {
      messages.push({ role: "tool", content: stringifyContent(message.content) });
    }
  }
  return messages;
}

function stringifyContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "thinking") return part.thinking;
    if (part.type === "toolCall") return JSON.stringify(part.arguments || {});
    if (part.type === "image") return "[" + part.mimeType + " image]";
    return "";
  }).join("\\n");
}

function normalizeToolCalls(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const args = typeof item.arguments === "string"
      ? JSON.parse(item.arguments)
      : (item.arguments || {});
    return {
      type: "toolCall",
      id: item.id,
      name: item.name,
      arguments: args,
    };
  }).filter((item) => item.id && item.name);
}

function createAssistantMessage(model, input, requestStartedAt) {
  const data = input.terminalData || {};
  return {
    role: "assistant",
    content: [
      ...(input.reasoning ? [{ type: "thinking", thinking: input.reasoning }] : []),
      ...(input.content ? [{ type: "text", text: input.content }] : []),
      ...input.toolCalls,
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    responseModel: typeof data.model === "string" ? data.model : undefined,
    usage: {
      input: data.usage?.inputTokens || 0,
      output: data.usage?.outputTokens || 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: data.usage?.totalTokens || 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: input.stopReason,
    timestamp: requestStartedAt,
  };
}

async function* readSseRecords(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const events = buffer.split(/\\r?\\n\\r?\\n/);
    buffer = events.pop() || "";
    for (const event of events) {
      const parsed = parseSseRecord(event);
      if (parsed) yield parsed;
    }
    if (done) break;
  }
  const trailing = parseSseRecord(buffer);
  if (trailing) yield trailing;
}

function parseSseRecord(value) {
  let event = "message";
  const data = [];
  for (const line of value.split(/\\r?\\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  return { event, data: JSON.parse(data.join("\\n")) };
}

function createStreamFn() {
  return async (model, context) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const requestStartedAt = Date.now();
      try {
        const response = await fetch(config.llmProxyUrl, {
          method: "POST",
          headers: {
            ...jsonHeaders(),
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            runId: config.runId,
            provider: config.llmProvider || "real",
            modelHint: config.modelHint || "pi-runtime",
            stream: true,
            thinkingLevel: config.thinkingLevel || "medium",
            messages: toLlmMessages(context),
            tools: context.tools || [],
          }),
        });
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.message || "LLM proxy request failed: " + response.status);
        }
        if (!response.body) throw new Error("LLM proxy returned an empty stream");
        let reasoning = "";
        let content = "";
        let toolCalls = [];
        let terminalData = {};
        let terminalSeen = false;
        let thinkingStarted = false;
        let textStarted = false;
        const partial = () => createAssistantMessage(model, {
          reasoning,
          content,
          toolCalls,
          terminalData,
          stopReason: "stop",
        }, requestStartedAt);

        stream.push({ type: "start", partial: partial() });
        for await (const record of readSseRecords(response.body)) {
          const data = record.data || {};
          if (record.event === "chunk") {
            const delta = typeof data.text === "string" ? data.text : "";
            if (!delta) continue;
            if (data.part === "reason") {
              if (textStarted) {
                throw new Error("LLM proxy emitted reasoning after content");
              }
              if (!thinkingStarted) {
                thinkingStarted = true;
                stream.push({ type: "thinking_start", contentIndex: 0, partial: partial() });
              }
              reasoning += delta;
              stream.push({ type: "thinking_delta", contentIndex: 0, delta, partial: partial() });
            } else if (data.part === "content") {
              const contentIndex = thinkingStarted ? 1 : 0;
              if (!textStarted) {
                textStarted = true;
                stream.push({ type: "text_start", contentIndex, partial: partial() });
              }
              content += delta;
              stream.push({ type: "text_delta", contentIndex, delta, partial: partial() });
            }
          } else if (record.event === "tool_calls") {
            toolCalls = normalizeToolCalls(data.toolCalls);
          } else if (record.event === "done") {
            terminalData = data;
            terminalSeen = true;
          } else if (record.event === "error") {
            throw new Error(data.message || "LLM proxy stream failed");
          }
        }
        if (!terminalSeen) throw new Error("LLM proxy stream ended before done");

        const stopReason = terminalData.finishReason === "tool_calls" ? "toolUse" : "stop";
        const message = createAssistantMessage(model, {
          reasoning,
          content,
          toolCalls,
          terminalData,
          stopReason,
        }, requestStartedAt);
        if (content) latestAssistantContent = content;
        if (thinkingStarted) {
          stream.push({ type: "thinking_end", contentIndex: 0, content: reasoning, partial: message });
        }
        if (textStarted) {
          const contentIndex = thinkingStarted ? 1 : 0;
          stream.push({ type: "text_end", contentIndex, content, partial: message });
        }
        for (const toolCall of toolCalls) {
          stream.push({
            type: "toolcall_end",
            contentIndex: message.content.indexOf(toolCall),
            toolCall,
            partial: message,
          });
        }
        stream.push({ type: "done", reason: stopReason, message });
        stream.end(message);
      } catch (error) {
        const message = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
          timestamp: requestStartedAt,
        };
        stream.push({ type: "error", reason: "error", error: message });
        stream.end(message);
      }
    })();
    return stream;
  };
}

const model = {
  id: "cap-llm-proxy",
  name: "Control Plane LLM Proxy",
  api: "openai-completions",
  provider: "cap-control-plane",
  baseUrl: config.llmProxyUrl,
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

try {
  await postHeartbeat("boot");
  await postRunEvent("run_created", null);
  await postRunEvent("runner_started", null);
  await postHeartbeat("agent_loop");
  await postRunEvent("agent_started", null);
  if (await stopIfCancelled()) {
    throw new Error("RUN_CANCELLED");
  }

  const agent = new Agent({
    sessionId: config.runId,
    initialState: {
	    systemPrompt: [
	        "You are a research workspace agent running inside an isolated Vercel Sandbox.",
	        "Use web_search for web research through the hosted Control Plane search proxy.",
	        "Use fetch_url to retrieve public URLs directly with SSRF protection.",
	        "Use read_file, write_file, list_directory, list_files, and run_command for workspace filesystem and bash tasks.",
	        "When the user asks to run a command, execute it with run_command and report the stdout, stderr, and exit code.",
	        "Use tools to write durable workspace files and create artifacts.",
	        "Never access database, Redis, auth, or long-lived provider credentials directly.",
	      ].join("\\n"),
      model,
      thinkingLevel: config.thinkingLevel || "medium",
      tools,
      messages: [],
    },
    getApiKey: () => config.runToken,
    streamFn: createStreamFn(),
    toolExecution: "sequential",
  });
  await agent.prompt(config.prompt);
  await ensureArtifactsForWrittenFiles();
  await postHeartbeat("finalize");

  const assistant = [...agent.state.messages].reverse().find(
    (message) => message.role === "assistant" && stringifyContent(message.content),
  );
  const assistantText =
    (assistant ? stringifyContent(assistant.content) : "") || latestAssistantContent;
  if (assistantText) {
    await postRunEvent("agent_message", { messageId: "pi-runtime-message-" + config.runId }, {
      role: "assistant",
      content: assistantText,
    });
  }
  if (await stopIfCancelled()) {
    throw new Error("RUN_CANCELLED");
  }
  await postRunEvent("run_completed", { durationMs: Date.now() - startedAt });

  console.log(JSON.stringify({
    piRuntimeStarted: true,
    completed: true,
    runId: config.runId,
    apiBaseUrl: config.apiBaseUrl,
    packages: config.packages,
    messageCount: agent.state.messages.length,
    forbiddenEnvPresent: forbiddenEnvKeys.some((key) => Boolean(process.env[key])),
  }));
  process.exit(0);
} catch (error) {
  if (!(error instanceof Error && error.message === "RUN_CANCELLED")) {
    await postRunEvent("run_failed", {
      errorCode: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    console.error(error);
    process.exit(1);
  }
  console.log(JSON.stringify({
    piRuntimeStarted: true,
    completed: false,
    cancelled: true,
    runId: config.runId,
    forbiddenEnvPresent: forbiddenEnvKeys.some((key) => Boolean(process.env[key])),
  }));
  process.exit(0);
}
`.trim();

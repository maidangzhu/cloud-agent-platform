import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentTool, AgentToolResult, StreamFn } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { fetchUrlTool } from "../tools/fetch-url.js";
import type { PiRuntimeStartConfig } from "./config.js";
import {
  asRecord,
  PiRuntimeControlPlaneClient,
  stringField,
  type ControlPlaneJson,
  type PiRuntimeTransport,
} from "./control-plane-client.js";

export type PiRuntimeAdaptersOptions = {
  config: PiRuntimeStartConfig;
  client?: PiRuntimeControlPlaneClient;
  transport?: PiRuntimeTransport;
  llmProvider?: "fake" | "real";
  searchProvider?: "fake" | "http" | "exa";
};

export type PiRuntimeAdapters = {
  client: PiRuntimeControlPlaneClient;
  streamFn: StreamFn;
  tools: AgentTool[];
};

export function createPiRuntimeAdapters(
  options: PiRuntimeAdaptersOptions,
): PiRuntimeAdapters {
  const client =
    options.client ??
    new PiRuntimeControlPlaneClient({
      config: options.config,
      transport: options.transport,
    });

  return {
    client,
    streamFn: createLlmProxyStreamFn(client, options.llmProvider),
    tools: createPiRuntimeAdapterTools(
      client,
      options.searchProvider ?? options.config.searchProvider,
    ),
  };
}

export function createLlmProxyStreamFn(
  client: PiRuntimeControlPlaneClient,
  provider: "fake" | "real" = "real",
): StreamFn {
  return async (model, context) => {
    const stream = createAssistantMessageEventStream();
    void resolveLlmProxyStream(stream, client, model, context, provider);
    return stream;
  };
}

export function createPiRuntimeAdapterTools(
  client: PiRuntimeControlPlaneClient,
  searchProvider?: "fake" | "http" | "exa",
): AgentTool[] {
  return [
    {
      name: "read_file",
      label: "Read file",
      description: "Read a UTF-8 text file from the sandbox workspace.",
      parameters: Type.Object({
        path: Type.String(),
      }),
      execute: async (toolCallId, rawParams) => {
        const params = rawParams as { path: string };
        return runTrackedTool(client, {
          toolCallId,
          name: "read_file",
          args: params,
          run: async () => {
            const resolved = resolveWorkspacePath(client.config.workspaceRoot, params.path);
            const stat = await fs.stat(resolved.absolute);
            if (!stat.isFile()) throw new Error("path is not a file");
            const content = await fs.readFile(resolved.absolute, "utf8");
            const truncated = byteLength(content) > MAX_FILE_READ_BYTES;
            const kept = truncated
              ? Buffer.from(content, "utf8")
                  .subarray(0, MAX_FILE_READ_BYTES)
                  .toString("utf8")
              : content;
            const details = {
              path: resolved.relative,
              content: kept,
              size: stat.size,
              truncated,
            };
            return toolResult([kept || "(empty file)"], details);
          },
        });
      },
    },
    {
      name: "list_directory",
      label: "List directory",
      description: "List files and directories under a sandbox workspace directory.",
      parameters: Type.Object({
        path: Type.Optional(Type.String()),
      }),
      execute: async (toolCallId, rawParams) => {
        const params = rawParams as { path?: string };
        return runTrackedTool(client, {
          toolCallId,
          name: "list_directory",
          args: params,
          run: async () => {
            const details = await listWorkspaceDirectory(
              client.config.workspaceRoot,
              params.path,
            );
            return toolResult([JSON.stringify(details.entries, null, 2)], details);
          },
        });
      },
    },
    {
      name: "list_files",
      label: "List files",
      description: "Alias for list_directory.",
      parameters: Type.Object({
        path: Type.Optional(Type.String()),
      }),
      execute: async (toolCallId, rawParams) => {
        const params = rawParams as { path?: string };
        return runTrackedTool(client, {
          toolCallId,
          name: "list_files",
          args: params,
          run: async () => {
            const details = await listWorkspaceDirectory(
              client.config.workspaceRoot,
              params.path,
            );
            return toolResult([JSON.stringify(details.entries, null, 2)], details);
          },
        });
      },
    },
    {
      name: "web_search",
      label: "Web search",
      description: "Search the web through the hosted Control Plane search proxy.",
      parameters: Type.Object({
        query: Type.String(),
        limit: Type.Optional(Type.Number()),
      }),
      execute: async (toolCallId, rawParams) => {
        const params = rawParams as { query: string; limit?: number };
        return runTrackedTool(client, {
          toolCallId,
          name: "web_search",
          args: params,
          run: async () => {
            const data = await client.callSearchProxy({
              query: params.query,
              limit: params.limit,
              provider: searchProvider,
            });
            return toolResult([JSON.stringify(data.results ?? [])], data);
          },
        });
      },
    },
    {
      name: "fetch_url",
      label: "Fetch URL",
      description: "Fetch and clean a public URL through the runtime fetch adapter.",
      parameters: Type.Object({
        url: Type.String(),
      }),
      execute: async (toolCallId, rawParams, signal) => {
        const params = rawParams as { url: string };
        return runTrackedTool(client, {
          toolCallId,
          name: "fetch_url",
          args: params,
          run: async () => {
            const result = await fetchUrlTool({
              url: params.url,
              transport: (url, init) => fetch(url, { ...init, signal }),
            });
            if (result.status !== "completed") {
              throw new RuntimeToolError(result.error, result.status);
            }
            return toolResult(
              [result.result.text ?? `Fetched ${result.result.url}`],
              result,
            );
          },
        });
      },
    },
    {
      name: "write_file",
      label: "Write file",
      description: "Write a workspace file through hosted ingest APIs.",
      parameters: Type.Object({
        path: Type.String(),
        content: Type.String(),
        mimeType: Type.Optional(Type.String()),
      }),
      execute: async (toolCallId, rawParams) => {
        const params = rawParams as {
          path: string;
          content: string;
          mimeType?: string;
        };
        return runTrackedTool(client, {
          toolCallId,
          name: "write_file",
          args: params,
          run: async (eventSeq) => {
            const resolved = resolveWorkspacePath(client.config.workspaceRoot, params.path);
            await fs.mkdir(path.dirname(resolved.absolute), { recursive: true });
            await fs.writeFile(resolved.absolute, params.content, "utf8");
            const result = await client.writeTextFile({
              path: resolved.relative,
              content: params.content,
              mimeType: params.mimeType,
              eventSeq,
            });
            return toolResult(
              [`Wrote ${stringField(result.file.path) ?? params.path}`],
              result.file,
            );
          },
        });
      },
    },
    {
      name: "run_command",
      label: "Run command",
      description:
        "Run a bash command inside the sandbox workspace with timeout, denylist, and output truncation.",
      parameters: Type.Object({
        command: Type.String(),
        timeoutMs: Type.Optional(Type.Number()),
      }),
      execute: async (toolCallId, rawParams) => {
        const params = rawParams as { command: string; timeoutMs?: number };
        return runTrackedTool(client, {
          toolCallId,
          name: "run_command",
          args: params,
          run: async () => {
            const command = assertCommandAllowed(client.config, params.command);
            const timeoutMs = Math.min(
              Math.max(params.timeoutMs ?? 120_000, 1000),
              Math.max(client.config.maxDurationSec * 1000, 1000),
            );
            const details = await runBashCommand({
              command,
              cwd: client.config.workspaceRoot,
              timeoutMs,
            });
            const output = [
              `$ ${command}`,
              details.stdout,
              details.stderr,
              details.timedOut ? "(command timed out)" : "",
              details.exitCode === 0 ? "" : `(exit code ${details.exitCode})`,
            ].filter(Boolean).join("\n");
            return toolResult([output || "(no output)"], details);
          },
        });
      },
    },
    {
      name: "create_artifact",
      label: "Create artifact",
      description:
        "Create or update a workspace artifact through hosted ingest APIs. Use kind text, code, sheet, or image.",
      parameters: Type.Object({
        title: Type.String(),
        kind: Type.Enum(["text", "code", "sheet", "image"]),
        path: Type.Optional(Type.String()),
        contentSnapshot: Type.Optional(Type.String()),
        storageKey: Type.Optional(Type.String()),
        artifactId: Type.Optional(Type.String()),
      }),
      execute: async (toolCallId, rawParams) => {
        const params = rawParams as {
          title: string;
          kind: string;
          path?: string;
          contentSnapshot?: string;
          storageKey?: string;
          artifactId?: string;
        };
        return runTrackedTool(client, {
          toolCallId,
          name: "create_artifact",
          args: params,
          run: async (eventSeq) => {
            const result = await client.createOrUpdateArtifact({
              title: params.title,
              kind: params.kind,
              path: params.path,
              contentSnapshot: params.contentSnapshot,
              storageKey: params.storageKey,
              artifactId: params.artifactId,
              eventSeq,
            });
            return toolResult(
              [`Created artifact ${stringField(result.artifact.title) ?? params.title}`],
              result.artifact,
              true,
            );
          },
        });
      },
    },
  ];
}

async function resolveLlmProxyStream(
  stream: AssistantMessageEventStream,
  client: PiRuntimeControlPlaneClient,
  model: Model<any>,
  context: Context,
  provider: "fake" | "real",
): Promise<void> {
  const startedAt = Date.now();
  try {
    const data = await client.callLlmProxy({
      provider,
      modelHint: model.id,
      stream: false,
      messages: toLlmProxyMessages(context),
      tools: context.tools ?? [],
    });
    const output = asRecord(data.output);
    const reasoning = stringField(output.reasoning);
    const content = stringField(output.content) ?? "";
    const message = createAssistantMessage({
      model,
      data,
      content,
      reasoning,
      toolCalls: normalizeToolCalls(output.toolCalls),
      stopReason:
        stringField(data.finishReason) === "tool_calls" ? "toolUse" : "stop",
      startedAt,
    });

    await Promise.all([
      reasoning ? client.postStreamChunk("thinking", reasoning) : Promise.resolve(null),
      content ? client.postStreamChunk("content", content) : Promise.resolve(null),
    ]);

    stream.push({ type: "start", partial: message });
    if (reasoning) {
      stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
      stream.push({
        type: "thinking_delta",
        contentIndex: 0,
        delta: reasoning,
        partial: message,
      });
      stream.push({
        type: "thinking_end",
        contentIndex: 0,
        content: reasoning,
        partial: message,
      });
    }
    if (content) {
      const contentIndex = reasoning ? 1 : 0;
      stream.push({ type: "text_start", contentIndex, partial: message });
      stream.push({
        type: "text_delta",
        contentIndex,
        delta: content,
        partial: message,
      });
      stream.push({
        type: "text_end",
        contentIndex,
        content,
        partial: message,
      });
    }
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
    stream.end(message);
  } catch (err) {
    const message = createAssistantMessage({
      model,
      data: {},
      content: "",
      toolCalls: [],
      stopReason: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
      startedAt,
    });
    stream.push({ type: "error", reason: "error", error: message });
    stream.end(message);
  }
}

async function runTrackedTool<TDetails>(
  client: PiRuntimeControlPlaneClient,
  input: {
    toolCallId: string;
    name: string;
    args: unknown;
    run: (eventSeq: number) => Promise<AgentToolResult<TDetails>>;
  },
): Promise<AgentToolResult<TDetails>> {
  const startedEventSeq = client.nextSeq();
  await client.postToolCall({
    id: input.toolCallId,
    eventSeq: startedEventSeq,
    name: input.name,
    status: "running",
    args: input.args,
  });
  try {
    const result = await input.run(client.nextSeq());
    await client.postToolCall({
      id: input.toolCallId,
      eventSeq: client.nextSeq(),
      name: input.name,
      status: "completed",
      args: input.args,
      result: result.details,
      completedAt: new Date(),
    });
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await client.postToolCall({
      id: input.toolCallId,
      eventSeq: client.nextSeq(),
      name: input.name,
      status: err instanceof RuntimeToolError ? err.status : "failed",
      args: input.args,
      error,
      completedAt: new Date(),
    });
    throw err;
  }
}

const MAX_LIST_ENTRIES = 200;
const MAX_FILE_READ_BYTES = 120_000;
const MAX_COMMAND_OUTPUT_CHARS = 20_000;

class RuntimeToolError extends Error {
  constructor(
    message: string,
    readonly status: "failed" | "rejected",
  ) {
    super(message);
    this.name = "RuntimeToolError";
  }
}

function resolveWorkspacePath(
  workspaceRoot: string,
  inputPath: string | undefined,
): { relative: string; absolute: string } {
  const rawPath = (inputPath ?? ".").trim();
  if (!rawPath || rawPath.includes("\0")) {
    throw new Error("path is required");
  }
  if (path.isAbsolute(rawPath)) {
    throw new Error("absolute paths are not allowed");
  }
  const normalized = path.normalize(rawPath).replace(/^\.\//, "");
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error("path must stay inside workspace");
  }
  const root = path.resolve(workspaceRoot);
  const absolute = path.resolve(root, normalized || ".");
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error("path must stay inside workspace");
  }
  return { relative: normalized || ".", absolute };
}

async function listWorkspaceDirectory(
  workspaceRoot: string,
  inputPath: string | undefined,
): Promise<{
  path: string;
  entries: Array<{ name: string; path: string; kind: "file" | "directory"; size: number }>;
  truncated: boolean;
}> {
  const resolved = resolveWorkspacePath(workspaceRoot, inputPath);
  const dirents = await fs.readdir(resolved.absolute, { withFileTypes: true });
  const entries = await Promise.all(
    dirents.slice(0, MAX_LIST_ENTRIES).map(async (entry) => {
      const childPath = path.join(resolved.absolute, entry.name);
      const stat = await fs.stat(childPath);
      return {
        name: entry.name,
        path: path.relative(workspaceRoot, childPath) || ".",
        kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
        size: entry.isDirectory() ? 0 : stat.size,
      };
    }),
  );
  return {
    path: resolved.relative,
    entries,
    truncated: dirents.length > MAX_LIST_ENTRIES,
  };
}

function assertCommandAllowed(
  config: PiRuntimeStartConfig,
  commandValue: string,
): string {
  if (config.toolPolicy.allowRunCommand !== true) {
    throw new Error("run_command is disabled by policy");
  }
  const command = commandValue.trim();
  if (!command) throw new Error("command is required");
  const lower = command.toLowerCase();
  for (const denied of config.toolPolicy.denyCommands) {
    if (denied && lower.includes(denied.toLowerCase())) {
      throw new Error(`command rejected by policy: ${denied}`);
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
  return command;
}

async function runBashCommand(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
}): Promise<{
  command: string;
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}> {
  await fs.mkdir(input.cwd, { recursive: true });
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    const child = spawn("bash", ["-lc", input.command], {
      cwd: input.cwd,
      env: {
        PATH: process.env.PATH,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        TMPDIR: process.env.TMPDIR,
        HOME: input.cwd,
        npm_config_cache: path.join(input.cwd, ".npm"),
        npm_config_yes: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, input.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      const next = truncateText(stdout + chunk.toString("utf8"));
      stdout = next.text;
      stdoutTruncated = stdoutTruncated || next.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const next = truncateText(stderr + chunk.toString("utf8"));
      stderr = next.text;
      stderrTruncated = stderrTruncated || next.truncated;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        command: input.command,
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
        command: input.command,
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

function truncateText(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_COMMAND_OUTPUT_CHARS) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, MAX_COMMAND_OUTPUT_CHARS), truncated: true };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function createAssistantMessage(input: {
  model: Model<any>;
  data: ControlPlaneJson;
  content: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  stopReason: AssistantMessage["stopReason"];
  errorMessage?: string;
  startedAt: number;
}): AssistantMessage {
  const content = [
    ...(input.reasoning ? [{ type: "thinking" as const, thinking: input.reasoning }] : []),
    ...(input.content ? [{ type: "text" as const, text: input.content }] : []),
    ...input.toolCalls,
  ];
  return {
    role: "assistant",
    content,
    api: input.model.api,
    provider: input.model.provider,
    model: input.model.id,
    responseModel: stringField(input.data.model),
    usage: normalizeUsage(input.data.usage),
    stopReason: input.stopReason,
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    timestamp: input.startedAt,
  };
}

function normalizeUsage(value: unknown): AssistantMessage["usage"] {
  const usage = asRecord(value);
  const input = numberValue(usage.inputTokens);
  const output = numberValue(usage.outputTokens);
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: numberValue(usage.totalTokens) || input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function toLlmProxyMessages(context: Context) {
  const messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }> = [];
  if (context.systemPrompt) {
    messages.push({ role: "system", content: context.systemPrompt });
  }
  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: stringifyMessageContent(message.content) });
    }
    if (message.role === "assistant") {
      messages.push({ role: "assistant", content: stringifyMessageContent(message.content) });
    }
    if (message.role === "toolResult") {
      messages.push({ role: "tool", content: stringifyMessageContent(message.content) });
    }
  }
  return messages;
}

function stringifyMessageContent(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return part.thinking;
      if (part.type === "toolCall") return JSON.stringify(part.arguments);
      return `[${part.mimeType} image]`;
    })
    .join("\n");
}

function normalizeToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const id = stringField(record.id);
      const name = stringField(record.name);
      if (!id || !name) return null;
      return {
        type: "toolCall" as const,
        id,
        name,
        arguments:
          typeof record.arguments === "string"
            ? parseJsonRecord(record.arguments)
            : asRecord(record.arguments),
      };
    })
    .filter((item): item is ToolCall => Boolean(item));
}

function toolResult<TDetails>(
  text: string[],
  details: TDetails,
  terminate = false,
): AgentToolResult<TDetails> {
  return {
    content: text.map((content) => ({ type: "text" as const, text: content })),
    details,
    ...(terminate ? { terminate: true } : {}),
  };
}

function parseJsonRecord(value: string): Record<string, unknown> {
  return asRecord(JSON.parse(value) as unknown);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export const PI_RUNTIME_SANDBOX_SCRIPT = `
import fs from "node:fs";
import { createHash } from "node:crypto";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type, createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const configFile = process.env.CAP_PI_RUNTIME_CONFIG_FILE || "pi-runtime-config.json";
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
const startedAt = Date.now();
let seq = 1;

const forbiddenEnvKeys = [
  "DATABASE_URL",
  "DIRECT_URL",
  "BETTER_AUTH_SECRET",
  "RUN_TOKEN_SECRET",
  "OPENAI_API_KEY",
  "EXA_API_KEY",
  "REDIS_URL",
];

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

async function runTrackedTool(toolCallId, name, args, run) {
  const eventSeq = seq++;
  await postToolCall({
    id: toolCallId,
    eventSeq,
    name,
    status: "running",
    args,
  });
  try {
    const result = await run(eventSeq);
    await postToolCall({
      id: toolCallId,
      eventSeq,
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
      eventSeq,
      name,
      status: "failed",
      args,
      error: error instanceof Error ? error.message : String(error),
      completedAt: new Date().toISOString(),
    });
    throw error;
  }
}

function sha256(value) {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function textResult(text, details) {
  return {
    content: [{ type: "text", text }],
    details,
    terminate: true,
  };
}

const tools = [
  {
    name: "write_file",
    label: "Write file",
    description: "Write a workspace file through hosted ingest APIs.",
    parameters: Type.Object({
      path: Type.String(),
      content: Type.String(),
      mimeType: Type.Optional(Type.String()),
    }),
    execute: async (toolCallId, params) => runTrackedTool(toolCallId, "write_file", params, async (eventSeq) => {
      const contentHash = sha256(params.content);
      const fileData = await postJson(config.ingestUrl + "/files", {
        path: params.path,
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
          path: file.path || params.path,
          size: typeof file.size === "number" ? file.size : byteLength(params.content),
          contentHash: file.contentHash || contentHash,
        },
      });
      return textResult("Wrote " + (file.path || params.path), file);
    }),
  },
  {
    name: "create_artifact",
    label: "Create artifact",
    description: "Create or update a workspace artifact through hosted ingest APIs.",
    parameters: Type.Object({
      title: Type.String(),
      kind: Type.String(),
      path: Type.Optional(Type.String()),
      contentSnapshot: Type.Optional(Type.String()),
      storageKey: Type.Optional(Type.String()),
      artifactId: Type.Optional(Type.String()),
    }),
    execute: async (toolCallId, params) => runTrackedTool(toolCallId, "create_artifact", params, async (eventSeq) => {
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
      return textResult("Created artifact " + (artifact.title || params.title), artifact);
    }),
  },
];

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

function createAssistantMessage(model, data, requestStartedAt) {
  const output = data.output || {};
  const reasoning = typeof output.reasoning === "string" ? output.reasoning : "";
  const content = typeof output.content === "string" ? output.content : "";
  const toolCalls = normalizeToolCalls(output.toolCalls);
  return {
    role: "assistant",
    content: [
      ...(reasoning ? [{ type: "thinking", thinking: reasoning }] : []),
      ...(content ? [{ type: "text", text: content }] : []),
      ...toolCalls,
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
    stopReason: data.finishReason === "tool_calls" ? "toolUse" : "stop",
    timestamp: requestStartedAt,
  };
}

function createStreamFn() {
  return async (model, context) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const requestStartedAt = Date.now();
      try {
        const data = await postJson(config.llmProxyUrl, {
          provider: config.llmProvider || "real",
          modelHint: config.modelHint || "pi-runtime",
          stream: false,
          messages: toLlmMessages(context),
          tools: context.tools || [],
        });
        const message = createAssistantMessage(model, data, requestStartedAt);
        const textBlock = message.content.find((part) => part.type === "text");
        stream.push({ type: "start", partial: message });
        if (textBlock) {
          const contentIndex = message.content.indexOf(textBlock);
          stream.push({ type: "text_start", contentIndex, partial: message });
          stream.push({ type: "text_delta", contentIndex, delta: textBlock.text, partial: message });
          stream.push({ type: "text_end", contentIndex, content: textBlock.text, partial: message });
        }
        for (const toolCall of message.content.filter((part) => part.type === "toolCall")) {
          stream.push({
            type: "toolcall_end",
            contentIndex: message.content.indexOf(toolCall),
            toolCall,
            partial: message,
          });
        }
        stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
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
  reasoning: false,
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
        "Use tools to write durable workspace files and create artifacts.",
        "Never access database, Redis, auth, or long-lived provider credentials directly.",
      ].join("\\n"),
      model,
      thinkingLevel: "off",
      tools,
      messages: [],
    },
    getApiKey: () => config.runToken,
    streamFn: createStreamFn(),
    toolExecution: "sequential",
  });
  await agent.prompt(config.prompt);
  await postHeartbeat("finalize");

  const assistant = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
  const assistantText = assistant ? stringifyContent(assistant.content) : "";
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
} catch (error) {
  if (!(error instanceof Error && error.message === "RUN_CANCELLED")) {
    await postRunEvent("run_failed", {
      errorCode: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    throw error;
  }
  console.log(JSON.stringify({
    piRuntimeStarted: true,
    completed: false,
    cancelled: true,
    runId: config.runId,
    forbiddenEnvPresent: forbiddenEnvKeys.some((key) => Boolean(process.env[key])),
  }));
}
`.trim();

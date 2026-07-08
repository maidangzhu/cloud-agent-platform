export const PI_RUNTIME_SANDBOX_SCRIPT = `
import fs from "node:fs";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const configFile = process.env.CAP_PI_RUNTIME_CONFIG_FILE || "pi-runtime-config.json";
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
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

function createAssistantMessage(model, data, startedAt) {
  const output = data.output || {};
  const reasoning = typeof output.reasoning === "string" ? output.reasoning : "";
  const content = typeof output.content === "string" ? output.content : "";
  return {
    role: "assistant",
    content: [
      ...(reasoning ? [{ type: "thinking", thinking: reasoning }] : []),
      ...(content ? [{ type: "text", text: content }] : []),
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
    timestamp: startedAt,
  };
}

function createStreamFn() {
  return async (model, context) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const startedAt = Date.now();
      try {
        const data = await postJson(config.llmProxyUrl, {
          provider: "fake",
          modelHint: "pi-runtime-smoke",
          stream: false,
          messages: toLlmMessages(context),
          tools: context.tools || [],
        });
        const message = createAssistantMessage(model, data, startedAt);
        const textBlock = message.content.find((part) => part.type === "text");
        stream.push({ type: "start", partial: message });
        if (textBlock) {
          stream.push({ type: "text_start", contentIndex: message.content.indexOf(textBlock), partial: message });
          stream.push({ type: "text_delta", contentIndex: message.content.indexOf(textBlock), delta: textBlock.text, partial: message });
          stream.push({ type: "text_end", contentIndex: message.content.indexOf(textBlock), content: textBlock.text, partial: message });
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
          timestamp: startedAt,
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

await postJson(config.ingestUrl + "/heartbeat", { status: "running", phase: "boot" });
const agent = new Agent({
  sessionId: config.runId,
  initialState: {
    systemPrompt: "You are a Pi runtime smoke agent running inside Vercel Sandbox.",
    model,
    thinkingLevel: "off",
    tools: [],
    messages: [],
  },
  getApiKey: () => config.runToken,
  streamFn: createStreamFn(),
  toolExecution: "sequential",
});
await agent.prompt(config.prompt);
await postJson(config.ingestUrl + "/heartbeat", { status: "running", phase: "finalize" });

console.log(JSON.stringify({
  piRuntimeStarted: true,
  runId: config.runId,
  apiBaseUrl: config.apiBaseUrl,
  packages: config.packages,
  messageCount: agent.state.messages.length,
  forbiddenEnvPresent: forbiddenEnvKeys.some((key) => Boolean(process.env[key])),
}));
`.trim();

import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { PiRuntimeStartConfig } from "./config.js";
import { createPiRuntimeAdapters } from "./adapters.js";

export const PI_RUNTIME_SYSTEM_PROMPT = [
  "You are a research workspace agent running inside an isolated Vercel Sandbox.",
  "Use Control Plane adapters for model calls, search, fetch, files, artifacts, events, and terminal state.",
  "Never access database, Redis, auth, or long-lived provider credentials directly.",
].join("\n");

export type PiRuntimeAgentShell = {
  agent: Agent;
  model: Model<"openai-completions">;
  tools: AgentTool[];
};

export function createPiRuntimeAgentShell(
  config: PiRuntimeStartConfig,
): PiRuntimeAgentShell {
  const model: Model<"openai-completions"> = {
    id: "cap-llm-proxy",
    name: "Control Plane LLM Proxy",
    api: "openai-completions",
    provider: "cap-control-plane",
    baseUrl: config.llmProxyUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  };
  const adapters = createPiRuntimeAdapters({ config });
  const tools = adapters.tools;
  const agent = new Agent({
    sessionId: config.runId,
    initialState: {
      systemPrompt: PI_RUNTIME_SYSTEM_PROMPT,
      model,
      thinkingLevel: config.thinkingLevel,
      tools,
      messages: [],
    },
    toolExecution: "sequential",
    getApiKey: () => config.runToken,
    streamFn: adapters.streamFn,
  });

  return { agent, model, tools };
}

export function createPiRuntimeToolContracts(
  config: PiRuntimeStartConfig,
): AgentTool[] {
  return createPiRuntimeAdapters({ config }).tools;
}

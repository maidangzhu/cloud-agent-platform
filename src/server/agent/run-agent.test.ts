import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type StreamFunction,
} from "@earendil-works/pi-ai/base";

const dbEvents: { seq: number; type: string; raw?: unknown; content?: string }[] = [];
const runUpdates: unknown[] = [];
const artifactsCreated: unknown[] = [];
const messagesCreated: unknown[] = [];

const prismaMock = {
  run: {
    findUniqueOrThrow: vi.fn(async () => ({ status: "created" })),
    update: vi.fn(async (args) => {
      runUpdates.push(args);
      return args.data;
    }),
  },
  workspace: {
    upsert: vi.fn(async () => undefined),
  },
  message: {
    findMany: vi.fn(async () => []),
    create: vi.fn(async (args) => {
      messagesCreated.push(args);
      return args.data;
    }),
  },
  agentEvent: {
    create: vi.fn(async (args) => {
      dbEvents.push({
        seq: args.data.seq,
        type: args.data.type,
        raw: args.data.raw,
        content: args.data.content,
      });
      return args.data;
    }),
  },
  artifact: {
    create: vi.fn(async (args) => {
      artifactsCreated.push(args);
      return args.data;
    }),
  },
  toolCall: {
    create: vi.fn(),
    update: vi.fn(),
  },
};

vi.mock("../db/client", () => ({ prisma: prismaMock }));
vi.mock("../sandbox/factory", () => ({
  getOrCreateSandbox: vi.fn(async () => ({
    sandbox: {
      workingDir: "/workspace",
      getState: () => ({ provider: "test", sandboxName: "test-sandbox" }),
    },
  })),
}));
vi.mock("../tools/registry", () => ({ createTools: vi.fn(() => []) }));
vi.mock("./model", () => ({
  resolveModel: vi.fn(() => ({
    apiKey: "test-key",
    model: {
      id: "test-model",
      name: "test-model",
      api: "openai-completions",
      provider: "test",
      baseUrl: "https://example.test/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 1024,
    },
  })),
  resolveModelChain: vi.fn(() => [
    {
      key: "ch1-primary",
      channel: 1,
      tier: "primary",
      apiKey: "test-key",
      model: {
        id: "test-model",
        name: "test-model",
        api: "openai-completions",
        provider: "test",
        baseUrl: "https://example.test/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 1024,
      },
    },
    {
      key: "ch1-fallback",
      channel: 1,
      tier: "fallback",
      apiKey: "test-key",
      model: {
        id: "test-model-fb",
        name: "test-model-fb",
        api: "openai-completions",
        provider: "test",
        baseUrl: "https://example.test/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 1024,
      },
    },
  ]),
  resolvePrimaryModelId: vi.fn(() => "test-model"),
}));

let promptImpl: ((agent: FakeAgent, prompt: string) => Promise<void>) | undefined;
let abortImpl: (() => void) | undefined;

interface FakeAgentOptions {
  streamFn: StreamFunction;
}

class FakeAgent {
  readonly state: { messages: AssistantMessage[]; errorMessage?: string } = {
    messages: [],
  };

  constructor(readonly options: FakeAgentOptions) {}

  async prompt(prompt: string) {
    await promptImpl?.(this, prompt);
  }

  subscribe() {}

  abort() {
    abortImpl?.();
  }
}

vi.mock("@earendil-works/pi-agent-core", () => ({ Agent: FakeAgent }));

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

const model = {
  id: "test-model",
  name: "test-model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 1024,
} satisfies Model<"openai-completions">;

const context = {
  systemPrompt: "",
  messages: [],
  tools: [],
} satisfies Context;

describe("runAgent orchestration", () => {
  beforeEach(() => {
    dbEvents.length = 0;
    runUpdates.length = 0;
    artifactsCreated.length = 0;
    messagesCreated.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    promptImpl = undefined;
    abortImpl = undefined;
  });

  it("marks the run failed when LLM chain is fully exhausted (all entries fail)", async () => {
    vi.useFakeTimers();
    const { runAgent } = await import("./run-agent");
    // streamFn 在被 abort 后立即 emit error event + end（模拟 first-response timeout
    // 被 llm-retry 用尽后的产物，被 fallback 视为可重试 → 切到下一个 entry）
    const stalledStreamFn = vi.fn((_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      options?.signal?.addEventListener("abort", () => {
        // emit error event after abort
        const msg = {
          role: "assistant",
          content: [],
          api: "openai-completions",
          provider: "test",
          model: "test-model",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "error",
          errorMessage: "No LLM stream event within 10ms after 3 attempts",
          timestamp: Date.now(),
        } as AssistantMessage;
        stream.push({ type: "error", reason: "error", error: msg });
        stream.end(msg);
      });
      return stream;
    });

    promptImpl = async (agent) => {
      const stream = agent.options.streamFn(model, context, {});
      const consume = (async () => {
        for await (const event of stream) {
          void event;
        }
      })();
      // 触发 3 次 abort（单 entry 内部 retry 3 次）→ 失败 → fallback 切到 ch1-fallback →
      // ch1-fallback 同理 3 次失败 → 链耗尽 → outer error
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(10);
      await consume;
      const result = await stream.result();
      agent.state.errorMessage = result.errorMessage;
    };

    await runAgent({
      runId: "run-fallback-exhausted",
      sessionId: "session-1",
      userPrompt: "hello",
      llmStreamFn: stalledStreamFn,
      llmFirstResponseTimeoutMs: 10,
      llmFirstResponseMaxRetries: 2,
    });

    // 单 entry 内部被调 3 次（maxRetries+1），2 个 entry 共 6 次
    expect(stalledStreamFn).toHaveBeenCalledTimes(6);
    // fallback 链耗尽 → run 走 failed
    const types = dbEvents.map((event) => event.type);
    expect(types).toContain("llm_entry_started");
    expect(types).toContain("llm_entry_failed");
    expect(types).toContain("llm_fallback_exhausted");
    expect(types).toContain("run_failed");
    expect(runUpdates).toContainEqual({
      where: { id: "run-fallback-exhausted" },
      data: expect.objectContaining({ status: "failed" }),
    });
  });

  it("writes only assistant Message for final answer and does not create Artifact", async () => {
    const { runAgent } = await import("./run-agent");

    promptImpl = async (agent) => {
      agent.state.messages.push(assistant("final answer"));
    };

    await runAgent({
      runId: "run-success",
      sessionId: "session-1",
      userPrompt: "hello",
    });

    expect(messagesCreated).toContainEqual({
      data: expect.objectContaining({
        sessionId: "session-1",
        role: "assistant",
        content: "final answer",
        runId: "run-success",
      }),
    });
    expect(artifactsCreated).toHaveLength(0);
    expect(dbEvents.map((event) => event.type)).not.toContain("artifact_created");
    expect(dbEvents.map((event) => event.type)).toContain("run_completed");
  });

  it("persists run_timeout when wall-clock maxDuration fires before agent.prompt returns", async () => {
    vi.useFakeTimers();
    const { runAgent } = await import("./run-agent");

    promptImpl = async () => {
      await new Promise<void>((resolve) => {
        abortImpl = resolve;
      });
    };

    const runPromise = runAgent({
      runId: "run-wall-timeout",
      sessionId: "session-1",
      userPrompt: "hello",
      maxDurationSec: 0.01,
    });

    await vi.advanceTimersByTimeAsync(10);
    await runPromise;

    expect(dbEvents.map((event) => event.type)).toContain("run_timeout");
    expect(runUpdates).toContainEqual({
      where: { id: "run-wall-timeout" },
      data: expect.objectContaining({ status: "timeout", completedAt: expect.any(Date) }),
    });
  });
});

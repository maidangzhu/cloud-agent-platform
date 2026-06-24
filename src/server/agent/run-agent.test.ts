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

  it("marks the run timeout when LLM first-response retries are exhausted", async () => {
    vi.useFakeTimers();
    const { runAgent } = await import("./run-agent");
    const stalledStreamFn = vi.fn((_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      options?.signal?.addEventListener("abort", () => undefined);
      return stream;
    });

    promptImpl = async (agent) => {
      const stream = agent.options.streamFn(model, context, {});
      const consume = (async () => {
        for await (const event of stream) {
          void event;
        }
      })();
      await vi.advanceTimersByTimeAsync(30);
      await consume;
      const result = await stream.result();
      agent.state.errorMessage = result.errorMessage;
    };

    await runAgent({
      runId: "run-timeout",
      sessionId: "session-1",
      userPrompt: "hello",
      llmStreamFn: stalledStreamFn,
      llmFirstResponseTimeoutMs: 10,
      llmFirstResponseMaxRetries: 2,
    });

    expect(stalledStreamFn).toHaveBeenCalledTimes(3);
    expect(dbEvents.map((event) => event.type)).toContain("run_timeout");
    expect(dbEvents.filter((event) => event.type === "llm_attempt_started")).toHaveLength(3);
    expect(dbEvents.filter((event) => event.type === "llm_attempt_timeout")).toHaveLength(3);
    expect(runUpdates).toContainEqual({
      where: { id: "run-timeout" },
      data: expect.objectContaining({ status: "timeout", completedAt: expect.any(Date) }),
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

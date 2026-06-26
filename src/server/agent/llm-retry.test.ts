import { describe, expect, it, vi, afterEach } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type StreamFunction,
} from "@earendil-works/pi-ai/base";
import {
  LlmFirstResponseTimeoutError,
  createFirstResponseRetryingStreamFn,
} from "./llm-retry";

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
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    },
  ],
  tools: [],
} satisfies Context;

function assistant(text = "ok"): AssistantMessage {
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

async function collectEventTypes(stream: AssistantMessageEventStream): Promise<string[]> {
  const events: string[] = [];
  for await (const event of stream) {
    events.push(event.type);
  }
  return events;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createFirstResponseRetryingStreamFn", () => {
  it("retries stalled first responses, records bounded events, then forwards the successful stream", async () => {
    vi.useFakeTimers();
    const recorded: { type: string; raw?: unknown }[] = [];
    let calls = 0;
    let aborts = 0;

    const baseStreamFn: StreamFunction = (_model, _context, options) => {
      calls++;
      const attempt = calls;
      const stream = createAssistantMessageEventStream();
      options?.signal?.addEventListener("abort", () => {
        aborts++;
      });

      if (attempt === 3) {
        setTimeout(() => stream.push({ type: "start", partial: assistant() }), 5);
        setTimeout(() => {
          const message = assistant("success on third attempt");
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
        }, 6);
      }

      return stream;
    };

    const retrying = createFirstResponseRetryingStreamFn({
      baseStreamFn,
      firstResponseTimeoutMs: 10,
      maxRetries: 2,
      recordEvent: async (type, opts) => {
        recorded.push({ type, raw: opts?.raw });
      },
    });

    const eventTypesPromise = collectEventTypes(retrying(model, context));

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(6);

    await expect(eventTypesPromise).resolves.toEqual(["start", "done"]);
    expect(calls).toBe(3);
    expect(aborts).toBe(2);
    expect(recorded.map((event) => event.type)).toEqual([
      "llm_attempt_started",
      "llm_attempt_timeout",
      "llm_attempt_started",
      "llm_attempt_timeout",
      "llm_attempt_started",
      "llm_attempt_succeeded",
    ]);
    expect(recorded.map((event) => event.raw)).toEqual([
      { attempt: 1, maxAttempts: 3, firstResponseTimeoutMs: 10, maxAttemptDurationMs: 300_000 },
      { attempt: 1, maxAttempts: 3, firstResponseTimeoutMs: 10, maxAttemptDurationMs: 300_000 },
      { attempt: 2, maxAttempts: 3, firstResponseTimeoutMs: 10, maxAttemptDurationMs: 300_000 },
      { attempt: 2, maxAttempts: 3, firstResponseTimeoutMs: 10, maxAttemptDurationMs: 300_000 },
      { attempt: 3, maxAttempts: 3, firstResponseTimeoutMs: 10, maxAttemptDurationMs: 300_000 },
      { attempt: 3, maxAttempts: 3, firstResponseTimeoutMs: 10, maxAttemptDurationMs: 300_000 },
    ]);
  });

  it("emits a timeout error after initial attempt plus two retries without forwarding stalled streams", async () => {
    vi.useFakeTimers();
    const recorded: string[] = [];
    let calls = 0;
    let aborts = 0;

    const baseStreamFn: StreamFunction = (_model, _context, options) => {
      calls++;
      const stream = createAssistantMessageEventStream();
      options?.signal?.addEventListener("abort", () => {
        aborts++;
      });
      return stream;
    };

    const retrying = createFirstResponseRetryingStreamFn({
      baseStreamFn,
      firstResponseTimeoutMs: 10,
      maxRetries: 2,
      recordEvent: async (type) => {
        recorded.push(type);
      },
    });

    const stream = retrying(model, context);
    const eventTypesPromise = collectEventTypes(stream);

    await vi.advanceTimersByTimeAsync(30);

    await expect(eventTypesPromise).resolves.toEqual(["error"]);
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("No LLM stream event within 10ms after 3 attempts");
    expect(calls).toBe(3);
    expect(aborts).toBe(3);
    expect(recorded).toEqual([
      "llm_attempt_started",
      "llm_attempt_timeout",
      "llm_attempt_started",
      "llm_attempt_timeout",
      "llm_attempt_started",
      "llm_attempt_timeout",
    ]);
  });

  it("exports a typed timeout error for run-agent terminal state handling", () => {
    const err = new LlmFirstResponseTimeoutError("timeout", {
      attempts: 3,
      timeoutMs: 10_000,
    });

    expect(err.name).toBe("LlmFirstResponseTimeoutError");
    expect(err.attempts).toBe(3);
    expect(err.timeoutMs).toBe(10_000);
  });
});

describe("max attempt duration (whole-stream hard timeout)", () => {
  it("aborts and errors when the entire stream exceeds maxAttemptDurationMs", async () => {
    vi.useFakeTimers();
    const recorded: { type: string; raw?: unknown }[] = [];
    const baseStreamFn: StreamFunction = (_model, _context) => {
      // 永远不 push 任何 event：模拟"首 token 永远不来"，触发 attempt duration 兜底
      // （firstResponseTimeoutMs 设大，让 attempt duration 先到期）
      return createAssistantMessageEventStream();
    };

    const retrying = createFirstResponseRetryingStreamFn({
      baseStreamFn,
      firstResponseTimeoutMs: 10_000, // 故意设大，让 attempt duration 先触发
      maxRetries: 1, // 2 attempts
      maxAttemptDurationMs: 50, // 50ms 后强制 abort
      recordEvent: async (type, opts) => {
        recorded.push({ type, raw: opts?.raw });
      },
    });

    const stream = retrying(model, context);
    const eventsPromise = collectEventTypes(stream);

    // attempt 1: 50ms 后 attempt duration 触发 -> attemptDurationError -> continue
    // attempt 2: 同样 50ms 后触发 -> attemptDurationError -> continue 失败
    await vi.advanceTimersByTimeAsync(60);
    await vi.advanceTimersByTimeAsync(60);

    const types = await eventsPromise;
    expect(types).toEqual(["error"]);
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/duration|timeout/i);
    // 两次 attempt 都有 started + duration_hit
    const starts = recorded.filter((e) => e.type === "llm_attempt_started").length;
    const hits = recorded.filter((e) => e.type === "llm_attempt_duration_hit").length;
    expect(starts).toBe(2);
    expect(hits).toBe(2);
  });

  it("end outer stream explicitly when retry is exhausted so fallback for-await exits", async () => {
    // 回归测试：retry 内部超时用尽后必须 outer.end() 显式调用，
    // 防止 fallback 的 for await 看不到 done 信号而永久挂起。
    vi.useFakeTimers();
    const baseStreamFn: StreamFunction = (_model) => {
      const stream = createAssistantMessageEventStream();
      // 永远不 push 任何 event
      return stream;
    };

    const retrying = createFirstResponseRetryingStreamFn({
      baseStreamFn,
      firstResponseTimeoutMs: 10,
      maxRetries: 1,
      maxAttemptDurationMs: 50,
      recordEvent: async () => {},
    });

    const stream = retrying(model, context);
    const typesPromise = collectEventTypes(stream);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);

    // 必须退出 for await，不能永久挂起
    const types = await typesPromise;
    expect(types).toEqual(["error"]);
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
  });

  it("default maxRetries is 1 (single retry on top of initial attempt)", () => {
    // 不传 maxRetries 时只重试 1 次；与 docs 注释"单 entry 内只重试一遍"对齐
    const fn = createFirstResponseRetryingStreamFn({});
    // 通过"创建的 stream 内部 closure 行为"间接验证 —— 跑一个永远不 emit 的 baseStreamFn
    vi.useFakeTimers();
    const baseStreamFn: StreamFunction = () => createAssistantMessageEventStream();
    const seen: string[] = [];
    const retrying = createFirstResponseRetryingStreamFn({
      baseStreamFn,
      firstResponseTimeoutMs: 10,
      maxAttemptDurationMs: 30,
      recordEvent: async (type) => seen.push(type),
    });
    const stream = retrying(model, context);
    const ep = collectEventTypes(stream);
    void vi.advanceTimersByTimeAsync(30);
    void vi.advanceTimersByTimeAsync(30);
    return ep.then((types) => {
      // 2 attempts × 2 events (started+timeout) = 4
      const starts = seen.filter((t) => t === "llm_attempt_started").length;
      expect(starts).toBe(2);
      expect(types).toEqual(["error"]);
    });
  });
});

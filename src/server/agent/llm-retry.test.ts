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
      { attempt: 1, maxAttempts: 3, timeoutMs: 10 },
      { attempt: 1, maxAttempts: 3, timeoutMs: 10 },
      { attempt: 2, maxAttempts: 3, timeoutMs: 10 },
      { attempt: 2, maxAttempts: 3, timeoutMs: 10 },
      { attempt: 3, maxAttempts: 3, timeoutMs: 10 },
      { attempt: 3, maxAttempts: 3, timeoutMs: 10 },
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

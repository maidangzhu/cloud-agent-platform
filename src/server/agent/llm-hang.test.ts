// 直击测试：LLM stream 永远不返回首 token，验证 retry 层的 attempt duration 兜底
// + fallback 切到下一个 entry + 最终 stream 整体 fail
// 真实运行时间应该远小于 maxAttemptDurationMs（我们用更小的超时加速测试）。
import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessageEventStream,
  type Model,
  type StreamFunction,
} from "@earendil-works/pi-ai/base";
import {
  createFirstResponseRetryingStreamFn,
  type LlmFirstResponseTimeoutError,
} from "./llm-retry";
import { createFallbackStreamFn } from "./llm-fallback";
import type { ModelChainEntry } from "./model";

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
} as any;

function makeEntry(key: string): ModelChainEntry {
  return {
    key,
    channel: 1,
    tier: "primary",
    model: {
      id: "m1",
      name: "m1",
      api: "openai-completions",
      provider: "relay",
      baseUrl: "https://example.test/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 1024,
    },
    apiKey: "k",
  };
}

describe("LLM hang (永不返回首 token) — 兜底链路", () => {
  it("single entry: 永远不 emit 的 stream，retry attempt duration 触发后整体 fail", async () => {
    // firstTokenTimeout 设大（5s），让 attempt duration（300ms）先触发 —— 验证后者兜底
    const FIRST_TOKEN_TIMEOUT = 5_000;
    const ATTEMPT_DURATION = 300;
    const MAX_RETRIES = 1; // 共 2 attempts

    // baseStreamFn: 永远不 push 任何 event
    const baseStreamFn: StreamFunction = () => createAssistantMessageEventStream();

    const retrying = createFirstResponseRetryingStreamFn({
      baseStreamFn,
      firstResponseTimeoutMs: FIRST_TOKEN_TIMEOUT,
      maxRetries: MAX_RETRIES,
      maxAttemptDurationMs: ATTEMPT_DURATION,
      recordEvent: async () => {},
    });

    const t0 = Date.now();
    const stream = retrying(model, context);

    // 1) 等到 attempt duration 到期：2 attempts × ATTEMPT_DURATION 但有 firstTokenTimeout 也会先到
    // 实际：每个 attempt 走 ATTEMPT_DURATION（因为 baseStreamFn 永远不 emit）→ 第二个也走 ATTEMPT_DURATION
    // → 总时间 ≈ 2 × ATTEMPT_DURATION + 微小开销
    const events: string[] = [];
    for await (const ev of stream) {
      events.push(ev.type);
    }
    const elapsed = Date.now() - t0;
    const result = await stream.result();

    console.log(`[hang-1] events=${JSON.stringify(events)} elapsed=${elapsed}ms stopReason=${result.stopReason} error=${result.errorMessage?.slice(0, 80)}`);

    // 必须退出 for await（不能 hang）
    expect(events).toEqual(["error"]);
    expect(result.stopReason).toBe("error");
    // 错误信息包含 duration / timeout
    expect(result.errorMessage).toMatch(/duration|timeout/i);
    // 兜底总时间 ≤ 2 × ATTEMPT_DURATION + 100ms 余量
    expect(elapsed).toBeLessThan(2 * ATTEMPT_DURATION + 200);
  });

  it("chain: 永远不 emit 的 stream，fallback 切到下个 entry，最终链耗尽 fail", async () => {
    const FIRST_TOKEN_TIMEOUT = 50;
    const ATTEMPT_DURATION = 150;
    const MAX_RETRIES = 1;

    const baseStreamFn: StreamFunction = () => createAssistantMessageEventStream();
    const retrying = createFirstResponseRetryingStreamFn({
      baseStreamFn,
      firstResponseTimeoutMs: FIRST_TOKEN_TIMEOUT,
      maxRetries: MAX_RETRIES,
      maxAttemptDurationMs: ATTEMPT_DURATION,
      recordEvent: async () => {},
    });

    const chain: ModelChainEntry[] = [makeEntry("e1"), makeEntry("e2"), makeEntry("e3")];

    const seen: string[] = [];
    const streamFn = createFallbackStreamFn(chain, {
      baseStreamFn: retrying,
      firstResponseTimeoutMs: FIRST_TOKEN_TIMEOUT,
      firstResponseMaxRetries: MAX_RETRIES,
      maxAttemptDurationMs: ATTEMPT_DURATION,
      recordEvent: async (type) => seen.push(type),
    });

    const t0 = Date.now();
    const stream = streamFn(chain[0].model as any, context, {});

    const events: string[] = [];
    for await (const ev of stream) {
      events.push(ev.type);
    }
    const elapsed = Date.now() - t0;
    const result = await stream.result();

    console.log(`[hang-2] events=${JSON.stringify(events)} elapsed=${elapsed}ms stopReason=${result.stopReason} events_emitted=${seen.join(",")}`);

    // 必须退出 for await
    expect(events).toEqual(["error"]);
    expect(result.stopReason).toBe("error");
    // 3 entry，每个 entry 内 2 attempts，每个 attempt 走 ATTEMPT_DURATION
    // 总时间 ≈ 3 × 2 × ATTEMPT_DURATION + 开销
    // 但 fallback 切 entry 时只是换 model，baseStreamFn 仍然永不 emit
    // 所以应该是 6 × ATTEMPT_DURATION ≈ 900ms
    const entryStarted = seen.filter((t) => t === "llm_entry_started").length;
    const entryFailed = seen.filter((t) => t === "llm_entry_failed").length;
    const exhausted = seen.filter((t) => t === "llm_fallback_exhausted").length;
    expect(entryStarted).toBe(3);
    expect(entryFailed).toBe(3);
    expect(exhausted).toBe(1);
    // 不能 hang
    expect(elapsed).toBeLessThan(3 * 2 * ATTEMPT_DURATION + 500);
  });

  it("chain: 第一 entry hang，第二 entry 立即成功 — 验证 fallback 切得动", async () => {
    const FIRST_TOKEN_TIMEOUT = 50;
    const ATTEMPT_DURATION = 150;
    const MAX_RETRIES = 1;

    // entry 计数器
    let callCount = 0;
    const baseStreamFn: StreamFunction = () => {
      callCount++;
      const idx = callCount;
      // 第 1、2 次 hang（entry 1 的两次 attempt），第 3、4 次 hang（entry 2 的两次 attempt）...
      // 简单做法：第 1 次 hang，第 2 次起成功
      if (idx === 1) return createAssistantMessageEventStream();
      // 成功：发 start + done
      const stream = createAssistantMessageEventStream();
      Promise.resolve().then(() => {
        stream.push({ type: "start", partial: { role: "assistant", content: [] } } as any);
        Promise.resolve().then(() => {
          stream.push({
            type: "done",
            reason: "stop",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
              api: "openai-completions",
              provider: "relay",
              model: "m1",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: "stop",
              timestamp: Date.now(),
            },
          } as any);
          stream.end({
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            api: "openai-completions",
            provider: "relay",
            model: "m1",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp: Date.now(),
          } as any);
        });
      });
      return stream;
    };

    const retrying = createFirstResponseRetryingStreamFn({
      baseStreamFn,
      firstResponseTimeoutMs: FIRST_TOKEN_TIMEOUT,
      maxRetries: MAX_RETRIES,
      maxAttemptDurationMs: ATTEMPT_DURATION,
      recordEvent: async () => {},
    });

    const chain: ModelChainEntry[] = [makeEntry("e1"), makeEntry("e2")];
    const streamFn = createFallbackStreamFn(chain, {
      baseStreamFn: retrying,
      firstResponseTimeoutMs: FIRST_TOKEN_TIMEOUT,
      firstResponseMaxRetries: MAX_RETRIES,
      maxAttemptDurationMs: ATTEMPT_DURATION,
      recordEvent: async () => {},
    });

    const t0 = Date.now();
    const stream = streamFn(chain[0].model as any, context, {});
    const events: string[] = [];
    for await (const ev of stream) events.push(ev.type);
    const elapsed = Date.now() - t0;
    const result = await stream.result();

    console.log(`[hang-3] events=${events} elapsed=${elapsed}ms stopReason=${result.stopReason} error=${result.errorMessage?.slice(0,60)}`);

    // 期望：拿到 "ok"，没 hang
    expect(result.stopReason).toBe("stop");
    expect(elapsed).toBeLessThan(2 * ATTEMPT_DURATION + 500);
  });
});

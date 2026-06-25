// llm-fallback 真实集成测试：打通真中转站，验证 fallback 在真实 5xx 下能切换。
// 不依赖沙箱/DB，只调用 fallback stream。
// 运行：pnpm test:integration -- src/server/agent/llm-fallback.integration.test.ts
//
// 需要 .env 至少有一个 OPENAI_BASE_URL + OPENAI_API_KEY。
// 若 ch2 未配置则 fallback chain 只有 2 个 entry；ch2 503 不会触发（不在链里）。

import { describe, expect, it } from "vitest";
import { streamSimple } from "@earendil-works/pi-ai/base";
import { createFallbackStreamFn } from "./llm-fallback";
import { resolveModelChain } from "./model";

const hasEnv = !!process.env.OPENAI_API_KEY?.trim() && !!process.env.OPENAI_BASE_URL?.trim();

describe.skipIf(!hasEnv)("llm-fallback 真实集成", () => {
  it("happy path：ch1 主模型返回 pong", async () => {
    const chain = resolveModelChain();
    expect(chain.length).toBeGreaterThan(0);

    const events: { type: string; raw?: unknown }[] = [];
    const fn = createFallbackStreamFn(chain, {
      baseStreamFn: streamSimple,
      firstResponseTimeoutMs: 30_000,
      maxRetries: 1,
      maxTotalAttempts: 8,
      recordEvent: async (type, e) => events.push({ type, raw: e?.raw }),
    });

    const ctx = {
      systemPrompt: "",
      messages: [
        { role: "user" as const, content: [{ type: "text" as const, text: "Reply with exactly: pong" }], timestamp: Date.now() },
      ],
      tools: [],
    };

    const stream = fn(chain[0].model, ctx, {});
    let assistantText = "";
    for await (const event of stream) {
      if (event.type === "done") {
        assistantText = event.message.content?.[0]?.text ?? "";
      }
    }
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    expect(assistantText.toLowerCase()).toContain("pong");
    expect(events.some((e) => e.type === "llm_entry_succeeded")).toBe(true);
  }, 120_000);

  it("ch1 primary + ch1 fallback → 成功（链稳定时直接命中 ch1 primary）", async () => {
    const chain = resolveModelChain();
    if (chain.length < 1) throw new Error("no chain");
    const startedKeys: string[] = [];
    const fn = createFallbackStreamFn(chain, {
      baseStreamFn: streamSimple,
      firstResponseTimeoutMs: 30_000,
      maxRetries: 1,
      recordEvent: async (type, e) => {
        if (type === "llm_entry_started") startedKeys.push((e?.raw as { key: string }).key);
      },
    });
    const ctx = {
      systemPrompt: "",
      messages: [
        { role: "user" as const, content: [{ type: "text" as const, text: "Say OK." }], timestamp: Date.now() },
      ],
      tools: [],
    };
    const stream = fn(chain[0].model, ctx, {});
    for await (const _ of stream) { /* drain */ }
    await stream.result();
    expect(startedKeys[0]).toBe("ch1-primary");
  }, 120_000);

  it("ch2 (micuapi) 在真实环境中是 503：fallback 切到 ch2 后能识别 503 并标 exhausted", async () => {
    // 手工构造只有 ch2 的链——验证 fallback 在真实 503 下能正确归类为 retryable / 走完整链。
    const apiKey2 = process.env.OPENAI_API_KEY2?.trim();
    const baseUrl2 = process.env.OPENAI_BASE_URL2?.trim();
    const model2 = process.env.LLM_MODEL2?.trim();
    const fallback2 = process.env.LLM_MODEL_FALLBACK2?.trim();
    if (!apiKey2 || !baseUrl2 || !model2) {
      console.log("skip: ch2 env not configured");
      return;
    }
    const buildModel = (id: string) => ({
      id, name: id, api: "openai-completions" as const,
      provider: "relay", baseUrl: baseUrl2, reasoning: true, input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000, maxTokens: 8192,
    });
    const chain = [
      { key: "ch2-primary", channel: 2 as const, tier: "primary" as const, apiKey: apiKey2, model: buildModel(model2) },
    ];
    if (fallback2 && fallback2 !== model2) {
      chain.push({
        key: "ch2-fallback", channel: 2 as const, tier: "fallback" as const,
        apiKey: apiKey2, model: buildModel(fallback2),
      });
    }
    const events: { type: string; raw?: unknown }[] = [];
    const fn = createFallbackStreamFn(chain, {
      baseStreamFn: streamSimple,
      firstResponseTimeoutMs: 15_000,
      maxRetries: 1,
      maxTotalAttempts: 6,
      recordEvent: async (type, e) => events.push({ type, raw: e?.raw }),
    });
    const ctx = {
      systemPrompt: "",
      messages: [
        { role: "user" as const, content: [{ type: "text" as const, text: "ping" }], timestamp: Date.now() },
      ],
      tools: [],
    };
    const stream = fn(chain[0].model, ctx, {});
    for await (const _ of stream) { /* drain */ }
    await stream.result();

    // ch2 当前 503 → fallback 应当尝试所有 entry 后 exhausted
    const started = events
      .filter((e) => e.type === "llm_entry_started")
      .map((e) => (e.raw as { key: string }).key);
    expect(started.length).toBe(chain.length);
    expect(events.some((e) => e.type === "llm_fallback_exhausted")).toBe(true);
    // 至少一个 entry 失败被记录
    expect(events.some((e) => e.type === "llm_entry_failed")).toBe(true);
  }, 120_000);
});
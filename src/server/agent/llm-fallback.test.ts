// llm-fallback 单元测试：覆盖 4 个 entry（ch1-primary / ch1-fallback / ch2-primary / ch2-fallback）
// + 每种失败模式（429 / 500 / 401 不重试 / network / first-response timeout）。
// 用 fake stream + fake model，零外部依赖。

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type StreamFunction,
} from "@earendil-works/pi-ai/base";
import {
  createFallbackStreamFn,
  defaultIsRetryable,
  extractErrorMessage,
} from "./llm-fallback";
import type { ModelChainEntry } from "./model";

function makeModel(id: string, baseUrl: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "relay",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 1024,
  };
}

function makeChain(): ModelChainEntry[] {
  return [
    {
      key: "ch1-primary",
      channel: 1,
      tier: "primary",
      apiKey: "key-1",
      model: makeModel("gpt-5.5", "https://ch1.example/v1"),
    },
    {
      key: "ch1-fallback",
      channel: 1,
      tier: "fallback",
      apiKey: "key-1",
      model: makeModel("gpt-5.4", "https://ch1.example/v1"),
    },
    {
      key: "ch2-primary",
      channel: 2,
      tier: "primary",
      apiKey: "key-2",
      model: makeModel("gpt-5.5", "https://ch2.example/v1"),
    },
    {
      key: "ch2-fallback",
      channel: 2,
      tier: "fallback",
      apiKey: "key-2",
      model: makeModel("gpt-5.4", "https://ch2.example/v1"),
    },
  ];
}

const context = {
  systemPrompt: "",
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() },
  ],
  tools: [],
} satisfies Context;

function makeAssistant(model: Model<"openai-completions">, text = "ok"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: model.provider,
    model: model.id,
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

function makeErrorAssistant(
  model: Model<"openai-completions">,
  errorMessage: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };
}

/** 失败 stream：emit error event + end。errorMessage 是会被 fallback 判断用的字符串。 */
function failingStream(
  model: Model<"openai-completions">,
  errorMessage: string,
): StreamFunction {
  return () => {
    const stream = createAssistantMessageEventStream();
    const msg = makeErrorAssistant(model, errorMessage);
    setTimeout(() => {
      stream.push({ type: "error", reason: "error", error: msg });
      stream.end(msg);
    }, 1);
    return stream;
  };
}

/** 成功 stream：push start + done。 */
function successStream(
  model: Model<"openai-completions">,
  text = "hello",
): StreamFunction {
  return () => {
    const stream = createAssistantMessageEventStream();
    const msg = makeAssistant(model, text);
    setTimeout(() => {
      stream.push({ type: "start", partial: msg });
      stream.push({ type: "done", reason: "stop", message: msg });
      stream.end(msg);
    }, 1);
    return stream;
  };
}

/** 模拟 pi-ai 的 "Stream ended without finish_reason" bug 形态：
 *  流过程中 push 了 start + 一些 delta（Agent 视为 partial success），
 *  但 result.stopReason="error" + errorMessage="Stream ended without finish_reason"。
 *  fallback 必须识别这是失败并切到下一个 entry。 */
function partialThenFailStream(
  model: Model<"openai-completions">,
  errorMessage: string,
): StreamFunction {
  return () => {
    const stream = createAssistantMessageEventStream();
    const partialMsg = makeAssistant(model, "");
    const errorMsg = makeErrorAssistant(model, errorMessage);
    setTimeout(() => {
      stream.push({ type: "start", partial: partialMsg });
      // 中途一个 error event（pi-ai catch 路径会推送）
      stream.push({ type: "error", reason: "error", error: errorMsg });
      stream.end(errorMsg);
    }, 1);
    return stream;
  };
}

async function collectAll<T>(stream: AssistantMessageEventStream): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of stream) out.push(ev as T);
  return out;
}

afterEach(() => {
  vi.useRealTimers();
});

/** route by model.id —— 每个 test 自定义 perEntry。 */
function makeRoutingBase(perEntry: Record<string, StreamFunction>): StreamFunction {
  return (model, ctx, opts) => {
    const fn = perEntry[model.id];
    if (!fn) throw new Error(`No perEntry for model.id=${model.id}`);
    return fn(model, ctx, opts);
  };
}

describe("createFallbackStreamFn — 入口解析", () => {
  it("空 chain 抛错", () => {
    expect(() => createFallbackStreamFn([])).toThrow(/chain is empty/);
  });
});

describe("createFallbackStreamFn — happy path（第一个 entry 成功）", () => {
  it("ch1-primary 直接成功：不切到 ch1-fallback / ch2-*", async () => {
    const chain = makeChain();
    const perEntry: Record<string, StreamFunction> = {
      "gpt-5.5": successStream(chain[0].model, "from ch1-primary"),
      "gpt-5.4": successStream(chain[1].model),
    };
    const events: { type: string; raw?: unknown }[] = [];
    const streamFn = createFallbackStreamFn(chain, {
      baseStreamFn: makeRoutingBase(perEntry),
      recordEvent: async (type, e) => events.push({ type, raw: e?.raw }),
    });
    const stream = streamFn(chain[0].model, context, {});
    const collected = await collectAll(stream);
    await stream.result();

    expect(collected.some((e: { type: string }) => e.type === "done")).toBe(true);
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("llm_entry_started");
    expect(eventTypes).toContain("llm_entry_succeeded");
    const startedKeys = events
      .filter((e) => e.type === "llm_entry_started")
      .map((e) => (e.raw as { key: string }).key);
    expect(startedKeys).toEqual(["ch1-primary"]);
  });
});

describe("createFallbackStreamFn — 同 channel 降级", () => {
  it("ch1-primary 500 → 切到 ch1-fallback → 成功", async () => {
    const chain = makeChain();
    const perEntry: Record<string, StreamFunction> = {
      "gpt-5.5": failingStream(chain[0].model, "500 Internal Server Error"),
      "gpt-5.4": successStream(chain[1].model, "from ch1-fallback"),
    };
    const events: { type: string; raw?: unknown }[] = [];
    const streamFn = createFallbackStreamFn(chain, {
      baseStreamFn: makeRoutingBase(perEntry),
      recordEvent: async (type, e) => events.push({ type, raw: e?.raw }),
    });
    const stream = streamFn(chain[0].model, context, {});
    const collected = await collectAll(stream);
    await stream.result();

    const startedKeys = events
      .filter((e) => e.type === "llm_entry_started")
      .map((e) => (e.raw as { key: string }).key);
    expect(startedKeys).toEqual(["ch1-primary", "ch1-fallback"]);
    expect(events.some((e) => e.type === "llm_entry_succeeded")).toBe(true);
    expect(collected.some((e: { type: string }) => e.type === "done")).toBe(true);
  });
});

describe("createFallbackStreamFn — 跨 channel 切换", () => {
  it("ch1-primary + ch1-fallback 都 5xx → 切到 ch2-primary 成功", async () => {
    const chain = makeChain();
    // 4 个 model.id 都不同（但 ch1-primary/ch2-primary 同 id "gpt-5.5"）
    // 通过 channel 区分：ch1 baseUrl="https://ch1.example/v1", ch2 baseUrl="https://ch2.example/v1"
    const perEntry: Record<string, StreamFunction> = {
      "https://ch1.example/v1|gpt-5.5": failingStream(chain[0].model, "502 Bad Gateway"),
      "https://ch1.example/v1|gpt-5.4": failingStream(chain[1].model, "503 Service Unavailable"),
      "https://ch2.example/v1|gpt-5.5": successStream(chain[2].model, "from ch2-primary"),
      "https://ch2.example/v1|gpt-5.4": successStream(chain[3].model),
    };
    const events: { type: string; raw?: unknown }[] = [];
    const streamFn = createFallbackStreamFn(chain, {
      baseStreamFn: (model, ctx, opts) => {
        const key = `${model.baseUrl}|${model.id}`;
        const fn = perEntry[key];
        if (!fn) throw new Error(`No perEntry for ${key}`);
        return fn(model, ctx, opts);
      },
      recordEvent: async (type, e) => events.push({ type, raw: e?.raw }),
    });
    const stream = streamFn(chain[0].model, context, {});
    const collected = await collectAll(stream);
    await stream.result();

    const startedKeys = events
      .filter((e) => e.type === "llm_entry_started")
      .map((e) => (e.raw as { key: string }).key);
    expect(startedKeys).toEqual(["ch1-primary", "ch1-fallback", "ch2-primary"]);
    expect(events.some((e) => e.type === "llm_entry_succeeded")).toBe(true);
    expect(collected.some((e: { type: string }) => e.type === "done")).toBe(true);
  });

  it("全部 4 个 entry 都失败 → exhaust → outer error", async () => {
    const chain = makeChain();
    const perEntry: Record<string, StreamFunction> = {
      "https://ch1.example/v1|gpt-5.5": failingStream(chain[0].model, "500 Internal Server Error"),
      "https://ch1.example/v1|gpt-5.4": failingStream(chain[1].model, "502 Bad Gateway"),
      "https://ch2.example/v1|gpt-5.5": failingStream(chain[2].model, "429 Too Many Requests"),
      "https://ch2.example/v1|gpt-5.4": failingStream(chain[3].model, "503 Service Unavailable"),
    };
    const events: { type: string; raw?: unknown }[] = [];
    const streamFn = createFallbackStreamFn(chain, {
      baseStreamFn: (model, ctx, opts) => {
        const key = `${model.baseUrl}|${model.id}`;
        const fn = perEntry[key];
        if (!fn) throw new Error(`No perEntry for ${key}`);
        return fn(model, ctx, opts);
      },
      recordEvent: async (type, e) => events.push({ type, raw: e?.raw }),
    });
    const stream = streamFn(chain[0].model, context, {});
    const collected = await collectAll(stream);
    const result = await stream.result();

    const startedKeys = events
      .filter((e) => e.type === "llm_entry_started")
      .map((e) => (e.raw as { key: string }).key);
    expect(startedKeys).toEqual(["ch1-primary", "ch1-fallback", "ch2-primary", "ch2-fallback"]);
    expect(events.some((e) => e.type === "llm_fallback_exhausted")).toBe(true);
    expect(collected.some((e: { type: string }) => e.type === "error")).toBe(true);
    expect(result.stopReason).toBe("error");
  });
});

describe("createFallbackStreamFn — 不可重试错误", () => {
  it("401 / 403 / 400 视为不可重试：直接放弃，不切到下一个 entry", async () => {
    const chain = makeChain();
    for (const errText of ["401 Unauthorized", "403 Forbidden", "400 Bad Request"]) {
      const perEntry: Record<string, StreamFunction> = {
        "gpt-5.5": failingStream(chain[0].model, errText),
        "gpt-5.4": successStream(chain[1].model),
      };
      const events: { type: string; raw?: unknown }[] = [];
      const streamFn = createFallbackStreamFn(chain, {
        baseStreamFn: makeRoutingBase(perEntry),
        recordEvent: async (type, e) => events.push({ type, raw: e?.raw }),
      });
      const stream = streamFn(chain[0].model, context, {});
      const collected = await collectAll(stream);
      await stream.result();

      const startedKeys = events
        .filter((e) => e.type === "llm_entry_started")
        .map((e) => (e.raw as { key: string }).key);
      expect(startedKeys).toEqual(["ch1-primary"]);
      expect(events.some((e) => e.type === "llm_fallback_giving_up_non_retryable")).toBe(true);
      expect(collected.some((e: { type: string }) => e.type === "error")).toBe(true);
    }
  });
});

describe("createFallbackStreamFn — 网络错误", () => {
  it("ECONNREFUSED / ETIMEDOUT 视为可重试：切换到下一个 entry", async () => {
    const chain = makeChain();
    for (const code of ["ECONNREFUSED", "ETIMEDOUT", "ECONNRESET"]) {
      // 网络错误包装：errorMessage 含关键词让 defaultIsRetryable 命中
      const errText = `${code}: connection failed`;
      const perEntry: Record<string, StreamFunction> = {
        "gpt-5.5": failingStream(chain[0].model, errText),
        "gpt-5.4": successStream(chain[1].model, "ok"),
      };
      const events: { type: string; raw?: unknown }[] = [];
      const streamFn = createFallbackStreamFn(chain, {
        baseStreamFn: makeRoutingBase(perEntry),
        recordEvent: async (type, e) => events.push({ type, raw: e?.raw }),
      });
      const stream = streamFn(chain[0].model, context, {});
      await collectAll(stream);
      await stream.result();

      const startedKeys = events
        .filter((e) => e.type === "llm_entry_started")
        .map((e) => (e.raw as { key: string }).key);
      expect(startedKeys).toEqual(["ch1-primary", "ch1-fallback"]);
    }
  });
});

describe("createFallbackStreamFn — cooldown", () => {
  it("失败的 entry 进入冷却：短时间内再次调用直接 skip", async () => {
    const chain = makeChain();
    const perEntry: Record<string, StreamFunction> = {
      "gpt-5.5": failingStream(chain[0].model, "500 Internal Server Error"),
      "gpt-5.4": failingStream(chain[1].model, "500 Internal Server Error"),
      "https://ch2.example/v1|gpt-5.5": successStream(chain[2].model, "ok"),
    };
    const now = vi.fn(() => 0);
    const events: { type: string; raw?: unknown }[] = [];
    const streamFn = createFallbackStreamFn(chain, {
      baseStreamFn: (model, ctx, opts) => {
        const key = model.baseUrl === "https://ch1.example/v1"
          ? model.id
          : `${model.baseUrl}|${model.id}`;
        const fn = perEntry[key];
        if (!fn) throw new Error(`No perEntry for ${key}`);
        return fn(model, ctx, opts);
      },
      cooldownMs: 60_000,
      now,
      recordEvent: async (type, e) => events.push({ type, raw: e?.raw }),
    });

    // 第一次：ch1-* 失败冷却，ch2-primary 成功
    const stream1 = streamFn(chain[0].model, context, {});
    await collectAll(stream1);
    await stream1.result();

    // 第二次：now 还是 0 → ch1-* 冷却中
    events.length = 0;
    const stream2 = streamFn(chain[0].model, context, {});
    await collectAll(stream2);
    await stream2.result();

    const startedKeys2 = events
      .filter((e) => e.type === "llm_entry_started")
      .map((e) => (e.raw as { key: string }).key);
    const skippedKeys = events
      .filter((e) => e.type === "llm_entry_skipped_cooldown")
      .map((e) => (e.raw as { key: string }).key);
    expect(skippedKeys).toContain("ch1-primary");
    expect(skippedKeys).toContain("ch1-fallback");
    expect(startedKeys2).toEqual(["ch2-primary"]);

    // 第三次：now 跳到 cooldownMs+1 → 冷却失效，ch1-primary 重新尝试
    events.length = 0;
    now.mockReturnValue(60_001);
    const stream3 = streamFn(chain[0].model, context, {});
    await collectAll(stream3);
    await stream3.result();
    const startedKeys3 = events
      .filter((e) => e.type === "llm_entry_started")
      .map((e) => (e.raw as { key: string }).key);
    expect(startedKeys3[0]).toBe("ch1-primary");
  });
});

describe("createFallbackStreamFn — 第一个 entry 之外的成功", () => {
  it("ch1-* 全部失败 → ch2-primary 成功 → 输出 assistant content", async () => {
    const chain = makeChain();
    const perEntry: Record<string, StreamFunction> = {
      "https://ch1.example/v1|gpt-5.5": failingStream(chain[0].model, "500 Internal Server Error"),
      "https://ch1.example/v1|gpt-5.4": failingStream(chain[1].model, "500 Internal Server Error"),
      "https://ch2.example/v1|gpt-5.5": successStream(chain[2].model, "rescued by ch2"),
      "https://ch2.example/v1|gpt-5.4": successStream(chain[3].model),
    };
    const events: { type: string; raw?: unknown }[] = [];
    const streamFn = createFallbackStreamFn(chain, {
      baseStreamFn: (model, ctx, opts) => {
        const key = `${model.baseUrl}|${model.id}`;
        const fn = perEntry[key];
        if (!fn) throw new Error(`No perEntry for ${key}`);
        return fn(model, ctx, opts);
      },
      recordEvent: async (type, e) => events.push({ type, raw: e?.raw }),
    });
    const stream = streamFn(chain[0].model, context, {});
    const collected = await collectAll<{ type: string; message?: AssistantMessage }>(stream);
    const result = await stream.result();

    const doneEvent = collected.find((e) => e.type === "done");
    expect(doneEvent).toBeTruthy();
    expect(doneEvent?.message?.content?.[0]).toMatchObject({
      type: "text",
      text: "rescued by ch2",
    });
    expect(result.stopReason).toBe("stop");
    expect(result.errorMessage).toBeUndefined();
  });
});

describe("createFallbackStreamFn — 回归：pi-ai 'Stream ended without finish_reason' 形态", () => {
  // 真实线上场景：ch1 偶尔会推到 start 之后流中断，pi-ai catch 路径 push error event
  // 并设 result.stopReason="error"、errorMessage="Stream ended without finish_reason"。
  // fallback 之前只看 stopReason，错误地标 succeeded，导致整个 chain 不切换 → run_failed。
  it("流里有 start + error event + result.errorMessage 非空 → 切到下一个 entry", async () => {
    const chain = makeChain();
    const perEntry: Record<string, StreamFunction> = {
      "gpt-5.5": partialThenFailStream(chain[0].model, "Stream ended without finish_reason"),
      "gpt-5.4": successStream(chain[1].model, "rescued"),
    };
    const events: { type: string; raw?: unknown }[] = [];
    const streamFn = createFallbackStreamFn(chain, {
      baseStreamFn: makeRoutingBase(perEntry),
      recordEvent: async (type, e) => events.push({ type, raw: e?.raw }),
    });
    const stream = streamFn(chain[0].model, context, {});
    await collectAll(stream);
    const result = await stream.result();

    const startedKeys = events
      .filter((e) => e.type === "llm_entry_started")
      .map((e) => (e.raw as { key: string }).key);
    expect(startedKeys).toEqual(["ch1-primary", "ch1-fallback"]);
    // ch1-primary 必须标 failed，不能标 succeeded
    const primaryEvents = events.filter(
      (e) => (e.raw as { key?: string })?.key === "ch1-primary",
    );
    expect(primaryEvents.some((e) => e.type === "llm_entry_failed")).toBe(true);
    expect(primaryEvents.some((e) => e.type === "llm_entry_succeeded")).toBe(false);
    // 最终 ch1-fallback 成功
    expect(result.stopReason).toBe("stop");
  });
});

describe("defaultIsRetryable 分类", () => {
  it("5xx 全部可重试", () => {
    for (const s of [500, 502, 503, 504]) {
      expect(defaultIsRetryable({ status: s })).toBe(true);
    }
  });
  it("429 可重试", () => {
    expect(defaultIsRetryable({ status: 429 })).toBe(true);
  });
  it("其他 4xx 不可重试", () => {
    for (const s of [400, 401, 403, 404, 422]) {
      expect(defaultIsRetryable({ status: s })).toBe(false);
    }
  });
  it("网络错误码可重试", () => {
    for (const code of ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]) {
      const e = Object.assign(new Error("x"), { code });
      expect(defaultIsRetryable(e)).toBe(true);
    }
  });
  it("first-response timeout 视为可重试（fallback 看到它说明上游 retry 已尽）", () => {
    const e = new Error("first response timeout");
    e.name = "LlmFirstResponseTimeoutError";
    expect(defaultIsRetryable(e)).toBe(true);
  });
  it("AssistantMessage.errorMessage 含 5xx → 可重试", () => {
    expect(defaultIsRetryable({ errorMessage: "500 Internal Server Error" })).toBe(true);
    expect(defaultIsRetryable({ errorMessage: "Error: 503 Service Unavailable" })).toBe(true);
  });
  it("AssistantMessage.errorMessage 含 429 → 可重试", () => {
    expect(defaultIsRetryable({ errorMessage: "429 Too Many Requests" })).toBe(true);
  });
  it("AssistantMessage.errorMessage 含 4xx 其他 → 不可重试", () => {
    expect(defaultIsRetryable({ errorMessage: "401 Unauthorized" })).toBe(false);
    expect(defaultIsRetryable({ errorMessage: "400 Bad Request" })).toBe(false);
  });
  it("AssistantMessage.errorMessage 含 first-response timeout 文本 → 可重试", () => {
    expect(
      defaultIsRetryable({
        errorMessage: "No LLM stream event within 10ms after 3 attempts",
      }),
    ).toBe(true);
    expect(
      defaultIsRetryable({
        errorMessage: "LLM first response timeout after 10000ms",
      }),
    ).toBe(true);
  });
  it("AssistantMessage.errorMessage 含任意 5xx 描述（不仅限标准 HTTP 文本）→ 可重试", () => {
    expect(defaultIsRetryable({ errorMessage: "503 No available channel for model" })).toBe(true);
    expect(defaultIsRetryable({ errorMessage: "Upstream 502 returned" })).toBe(true);
    expect(defaultIsRetryable({ errorMessage: "Error code: 504 - Gateway Timeout" })).toBe(true);
  });
});

describe("extractErrorMessage 抽取可读错误", () => {
  // 防止 run.error 落 [object Object]（线上出现过）。
  it("Error 实例 → 用 message", () => {
    expect(extractErrorMessage(new Error("boom"))).toBe("boom");
  });
  it("字符串 → 原样", () => {
    expect(extractErrorMessage("oops")).toBe("oops");
  });
  it("AssistantMessage 形态 → 抽 errorMessage", () => {
    expect(
      extractErrorMessage({
        errorMessage: "Stream ended without finish_reason",
        stopReason: "error",
      }),
    ).toBe("Stream ended without finish_reason");
  });
  it("有 message 字段的对象 → 用 message", () => {
    expect(extractErrorMessage({ message: "fetch failed" })).toBe("fetch failed");
  });
  it("null / undefined / 0 → fallback 字符串", () => {
    expect(extractErrorMessage(null)).toBe("(no error)");
    expect(extractErrorMessage(undefined)).toBe("(no error)");
  });
  it("没任何字段的奇怪对象 → JSON 序列化", () => {
    const out = extractErrorMessage({ weird: { nested: 1 } });
    // 至少不能是 "[object Object]"
    expect(out).not.toMatch(/^\[object /);
    expect(out.length).toBeGreaterThan(0);
  });
});

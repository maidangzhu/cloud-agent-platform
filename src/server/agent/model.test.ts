// model.ts 单元测试：resolveModelChain() 动态读 OPENAI_*_N 后缀。
// 隔离环境变量（不污染全局），每个 case 用 vi.stubEnv。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveModelChain, resolvePrimaryModelId } from "./model";

const SAVED_ENV: Record<string, string | undefined> = {};

const ENV_KEYS = [
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "LLM_MODEL", "LLM_MODEL_FALLBACK",
  "OPENAI_API_KEY2", "OPENAI_BASE_URL2", "LLM_MODEL2", "LLM_MODEL_FALLBACK2",
  "OPENAI_API_KEY3", "OPENAI_BASE_URL3", "LLM_MODEL3", "LLM_MODEL_FALLBACK3",
  "OPENAI_API_KEY4", "OPENAI_BASE_URL4", "LLM_MODEL4", "LLM_MODEL_FALLBACK4",
];

beforeEach(() => {
  for (const k of ENV_KEYS) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
  vi.unstubAllEnvs();
});

describe("resolveModelChain — 单 channel", () => {
  it("只配 ch1 → chain 长度 1（仅 primary，若 fallback 与 primary 相同则不入）", () => {
    process.env.OPENAI_API_KEY = "k1";
    process.env.OPENAI_BASE_URL = "https://ch1/v1";
    process.env.LLM_MODEL = "gpt-5.5";
    const chain = resolveModelChain();
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ key: "ch1-primary", channel: 1, tier: "primary" });
  });

  it("ch1 配 primary + fallback → chain 长度 2", () => {
    process.env.OPENAI_API_KEY = "k1";
    process.env.OPENAI_BASE_URL = "https://ch1/v1";
    process.env.LLM_MODEL = "gpt-5.5";
    process.env.LLM_MODEL_FALLBACK = "gpt-5.4";
    const chain = resolveModelChain();
    expect(chain.map((c) => c.key)).toEqual(["ch1-primary", "ch1-fallback"]);
    expect(chain[1]).toMatchObject({ channel: 1, tier: "fallback" });
    expect(chain[1].model.id).toBe("gpt-5.4");
    expect(chain[1].model.baseUrl).toBe("https://ch1/v1");
    // 同 channel 共用 apiKey
    expect(chain[1].apiKey).toBe("k1");
  });

  it("ch1 缺 OPENAI_API_KEY → 抛错", () => {
    process.env.OPENAI_BASE_URL = "https://ch1/v1";
    process.env.LLM_MODEL = "gpt-5.5";
    expect(() => resolveModelChain()).toThrow(/LLM 未配置/);
  });

  it("ch1 缺 OPENAI_BASE_URL → 抛错", () => {
    process.env.OPENAI_API_KEY = "k1";
    process.env.LLM_MODEL = "gpt-5.5";
    expect(() => resolveModelChain()).toThrow(/LLM 未配置/);
  });

  it("ch1 缺 LLM_MODEL → 抛错", () => {
    process.env.OPENAI_API_KEY = "k1";
    process.env.OPENAI_BASE_URL = "https://ch1/v1";
    expect(() => resolveModelChain()).toThrow(/LLM 未配置/);
  });
});

describe("resolveModelChain — 多 channel（动态数量）", () => {
  it("ch1 + ch2 → chain 长度 4", () => {
    process.env.OPENAI_API_KEY = "k1";
    process.env.OPENAI_BASE_URL = "https://ch1/v1";
    process.env.LLM_MODEL = "gpt-5.5";
    process.env.LLM_MODEL_FALLBACK = "gpt-5.4";
    process.env.OPENAI_API_KEY2 = "k2";
    process.env.OPENAI_BASE_URL2 = "https://ch2/v1";
    process.env.LLM_MODEL2 = "gpt-5.5";
    process.env.LLM_MODEL_FALLBACK2 = "gpt-5.4";
    const chain = resolveModelChain();
    expect(chain.map((c) => c.key)).toEqual([
      "ch1-primary", "ch1-fallback",
      "ch2-primary", "ch2-fallback",
    ]);
  });

  it("ch1 + ch2 + ch3 → chain 长度 6（验证动态扩展）", () => {
    process.env.OPENAI_API_KEY = "k1";
    process.env.OPENAI_BASE_URL = "https://ch1/v1";
    process.env.LLM_MODEL = "gpt-5.5";
    process.env.OPENAI_API_KEY2 = "k2";
    process.env.OPENAI_BASE_URL2 = "https://ch2/v1";
    process.env.LLM_MODEL2 = "gpt-5.5";
    process.env.OPENAI_API_KEY3 = "k3";
    process.env.OPENAI_BASE_URL3 = "https://ch3/v1";
    process.env.LLM_MODEL3 = "gpt-5.5";
    const chain = resolveModelChain();
    expect(chain.map((c) => c.key)).toEqual([
      "ch1-primary",
      "ch2-primary",
      "ch3-primary",
    ]);
    expect(chain.map((c) => c.channel)).toEqual([1, 2, 3]);
  });

  it("ch1 缺 LLM_MODEL2 不影响 ch1（每个 channel 独立判定）", () => {
    process.env.OPENAI_API_KEY = "k1";
    process.env.OPENAI_BASE_URL = "https://ch1/v1";
    process.env.LLM_MODEL = "gpt-5.5";
    // ch2 缺 LLM_MODEL2
    process.env.OPENAI_API_KEY2 = "k2";
    process.env.OPENAI_BASE_URL2 = "https://ch2/v1";
    const chain = resolveModelChain();
    expect(chain.map((c) => c.key)).toEqual(["ch1-primary"]);
  });

  it("ch1 + ch2 中间空 ch3 但有 ch4 → chain 不应包含 ch3，且 ch4 应该出现", () => {
    // 实际业务里 ch3 可能配了一半又被注释掉；按设计遇到第一个缺 apiKey 就 break。
    process.env.OPENAI_API_KEY = "k1";
    process.env.OPENAI_BASE_URL = "https://ch1/v1";
    process.env.LLM_MODEL = "gpt-5.5";
    process.env.OPENAI_API_KEY2 = "k2";
    process.env.OPENAI_BASE_URL2 = "https://ch2/v1";
    process.env.LLM_MODEL2 = "gpt-5.5";
    // 故意不配 ch3
    process.env.OPENAI_API_KEY4 = "k4";
    process.env.OPENAI_BASE_URL4 = "https://ch4/v1";
    process.env.LLM_MODEL4 = "gpt-5.5";
    const chain = resolveModelChain();
    expect(chain.map((c) => c.key)).toEqual(["ch1-primary", "ch2-primary"]);
    // 文档化这个限制：如果中间 channel 缺配，后面的 channel 不会被启用。
    // 业务上保证 channel 编号连续即可。
  });

  it("每个 channel 的 apiKey 独立传递（不会跨 channel 串）", () => {
    process.env.OPENAI_API_KEY = "k1";
    process.env.OPENAI_BASE_URL = "https://ch1/v1";
    process.env.LLM_MODEL = "gpt-5.5";
    process.env.OPENAI_API_KEY2 = "k2-different";
    process.env.OPENAI_BASE_URL2 = "https://ch2/v1";
    process.env.LLM_MODEL2 = "gpt-5.5";
    const chain = resolveModelChain();
    expect(chain.find((c) => c.channel === 1)?.apiKey).toBe("k1");
    expect(chain.find((c) => c.channel === 2)?.apiKey).toBe("k2-different");
  });
});

describe("resolvePrimaryModelId", () => {
  it("env 有 LLM_MODEL → 返回它", () => {
    process.env.LLM_MODEL = "gpt-5.5";
    expect(resolvePrimaryModelId()).toBe("gpt-5.5");
  });

  it("env 没 LLM_MODEL → 默认 gpt-4o", () => {
    expect(resolvePrimaryModelId()).toBe("gpt-4o");
  });
});
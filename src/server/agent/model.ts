// model.ts — 解析 LLM 模型配置 + fallback chain。
// 只用 OpenAI 兼容协议（api: "openai-completions"），baseUrl 指向中转站。
// 无 OPENAI_API_KEY 即报错——本项目不再提供 mock 回退，所有业务流程跑真实 LLM。
//
// Fallback 链顺序：channel[1] primary → channel[1] fallback → channel[2] primary → channel[2] fallback
// （若对应 env 未配置则跳过该槽位；链长度 ≥ 1；空链抛错）。
// 同名 LLM_MODEL_FALLBACK 默认等于 LLM_MODEL（仅同渠道降级模型，跨渠道已由 channel 覆盖）。

import type { Model } from "@earendil-works/pi-ai";
import "@earendil-works/pi-ai";

export interface ResolvedModel {
  model: Model<"openai-completions">;
  /** 供 Agent getApiKey 使用。 */
  apiKey: string;
}

export interface ModelChainEntry {
  /** 唯一标识，事件落库 / 日志用。 */
  key: string;
  /** Channel 序号（1-based），便于观察跨渠道切换。 */
  channel: 1 | 2;
  /** "primary" = 主模型；"fallback" = 同渠道降级模型。 */
  tier: "primary" | "fallback";
  apiKey: string;
  model: Model<"openai-completions">;
}

function buildModel(
  modelId: string,
  baseUrl: string,
): Model<"openai-completions"> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "relay" as string,
    baseUrl,
    reasoning: true,
    input: ["text"] as ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  } satisfies Model<"openai-completions">;
}

function envKey(idx: 1 | 2, suffix: "" | "2"): string {
  // 1: OPENAI_API_KEY / OPENAI_BASE_URL / LLM_MODEL / LLM_MODEL_FALLBACK
  // 2: OPENAI_API_KEY2 / OPENAI_BASE_URL2 / LLM_MODEL2 / LLM_MODEL_FALLBACK2
  return suffix;
}

/** 读取单个 channel 的配置，env 缺则返回 null（链中跳过）。 */
function readChannel(idx: 1 | 2): {
  channel: 1 | 2;
  apiKey: string;
  baseUrl: string;
  primary: string;
  fallback: string;
} | null {
  const suffix: "" | "2" = idx === 1 ? "" : "2";
  const apiKey = process.env[`OPENAI_API_KEY${suffix}`]?.trim();
  const baseUrl = process.env[`OPENAI_BASE_URL${suffix}`]?.trim();
  const primary = process.env[`LLM_MODEL${suffix}`]?.trim();
  const fallback = process.env[`LLM_MODEL_FALLBACK${suffix}`]?.trim();
  if (!apiKey || !baseUrl || !primary) return null;
  return {
    channel: idx,
    apiKey,
    baseUrl,
    primary,
    fallback: fallback || primary,
  };
}

/** 解析完整 fallback chain。env 全空抛错（与旧 resolveModel 行为一致）。 */
export function resolveModelChain(): ModelChainEntry[] {
  const chain: ModelChainEntry[] = [];
  for (const idx of [1, 2] as const) {
    const ch = readChannel(idx);
    if (!ch) continue;
    chain.push({
      key: `ch${ch.channel}-primary`,
      channel: ch.channel,
      tier: "primary",
      apiKey: ch.apiKey,
      model: buildModel(ch.primary, ch.baseUrl),
    });
    // fallback 模型与 primary 不同时才入链（避免重复尝试）
    if (ch.fallback !== ch.primary) {
      chain.push({
        key: `ch${ch.channel}-fallback`,
        channel: ch.channel,
        tier: "fallback",
        apiKey: ch.apiKey,
        model: buildModel(ch.fallback, ch.baseUrl),
      });
    }
  }
  if (chain.length === 0) {
    throw new Error(
      "LLM 未配置：run-agent 需要真实 LLM（OpenAI 兼容协议中转站）。请在 .env 设置 OPENAI_API_KEY / OPENAI_BASE_URL / LLM_MODEL（可选加 _2 后缀渠道）。",
    );
  }
  return chain;
}

/** 兼容旧调用：返回 chain[0]（主渠道主模型）。 */
export function resolveModel(): ResolvedModel {
  const chain = resolveModelChain();
  const first = chain[0];
  return { apiKey: first.apiKey, model: first.model };
}

/** 主模型 id（用于 assistant 历史消息落库）。取 channel1 primary。 */
export function resolvePrimaryModelId(): string {
  return process.env.LLM_MODEL?.trim() || "gpt-4o";
}

// model.ts — 解析 LLM 模型配置 + fallback chain。
// 只用 OpenAI 兼容协议（api: "openai-completions"），baseUrl 指向中转站。
// 无 OPENAI_API_KEY 即报错——本项目不再提供 mock 回退，所有业务流程跑真实 LLM。
//
// Channel 数量是动态的：循环 idx=1..N 直到 OPENAI_API_KEY{idx} 不存在为止。
//   channel 1: OPENAI_API_KEY / OPENAI_BASE_URL / LLM_MODEL[/LLM_MODEL_FALLBACK]
//   channel 2: OPENAI_API_KEY2 / OPENAI_BASE_URL2 / LLM_MODEL2[/LLM_MODEL_FALLBACK2]
//   channel N: OPENAI_API_KEY{N} / OPENAI_BASE_URL{N} / LLM_MODEL{N}[/LLM_MODEL_FALLBACK{N}]
//
// 同一 channel 内 primary→fallback 是模型降级；跨 channel 是中转站降级。
// 任意一个 channel 的 env 缺 key/baseUrl/primaryModel 都跳过该 channel。
// LLM_MODEL_FALLBACK{N} 未设或等于 LLM_MODEL{N} 时不入链（避免重复尝试）。
// 至少要有 channel 1，否则抛错。

import type { Model } from "@earendil-works/pi-ai";
import "@earendil-works/pi-ai";

/** 软上限：超过这个数量就停（防止 env 异常时无限循环）。 */
const MAX_CHANNELS = 20;

export interface ResolvedModel {
  model: Model<"openai-completions">;
  /** 供 Agent getApiKey 使用。 */
  apiKey: string;
}

export interface ModelChainEntry {
  /** 唯一标识，事件落库 / 日志用。 */
  key: string;
  /** Channel 序号（1-based），便于观察跨渠道切换。 */
  channel: number;
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
    // 不再强制 reasoning=true：reasoning 模型在 pi-ai 内部会注入 `role: "developer"`
    // 消息，部分 OpenAI 兼容中转站（特别是套壳 Anthropic 或 OpenAI 协议不严格实现的）
    // 会 400 拒收。如果以后某个 model 真的需要 reasoning，再单独加 flag。
    reasoning: false,
    input: ["text"] as ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  } satisfies Model<"openai-completions">;
}

/** 读取单个 channel 的配置，env 缺则返回 null（链中跳过）。
 *  idx=1 → 无后缀；idx>=2 → 加数字后缀。 */
function readChannel(idx: number): {
  channel: number;
  apiKey: string;
  baseUrl: string;
  primary: string;
  fallback: string;
} | null {
  const suffix = idx === 1 ? "" : String(idx);
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

/** 解析完整 fallback chain。从 idx=1 开始连续读，遇到没有 apiKey 的 idx 就停。 */
export function resolveModelChain(): ModelChainEntry[] {
  const chain: ModelChainEntry[] = [];
  for (let idx = 1; idx <= MAX_CHANNELS; idx++) {
    const ch = readChannel(idx);
    if (!ch) {
      // channel 1 必须有；channel >=2 缺则停止扫描（避免 env 漏配导致假阴性）
      if (idx === 1) {
        throw new Error(
          "LLM 未配置：run-agent 需要真实 LLM（OpenAI 兼容协议中转站）。请在 .env 设置 OPENAI_API_KEY / OPENAI_BASE_URL / LLM_MODEL（可选加 _N 后缀加更多 channel）。",
        );
      }
      break;
    }
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
      "LLM 未配置：run-agent 需要真实 LLM（OpenAI 兼容协议中转站）。请在 .env 设置 OPENAI_API_KEY / OPENAI_BASE_URL / LLM_MODEL（可选加 _N 后缀加更多 channel）。",
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
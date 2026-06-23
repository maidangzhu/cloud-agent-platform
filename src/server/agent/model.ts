// model.ts — 解析 LLM 模型配置。
// 只用 OpenAI 兼容协议（api: "openai-completions"），baseUrl 指向中转站（OPENAI_BASE_URL）。
// 导入 @earendil-works/pi-ai 会自动注册所有内置 provider（含 openai-completions）。
// 无 OPENAI_API_KEY 即报错——本项目不再提供 mock 回退，所有业务流程跑真实 LLM。

import type { Model } from "@earendil-works/pi-ai";
import "@earendil-works/pi-ai";

export interface ResolvedModel {
  model: Model<"openai-completions">;
  /** 供 Agent getApiKey 使用。 */
  apiKey: string;
}

export function resolveModel(): ResolvedModel {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY 未配置：run-agent 需要真实 LLM（OpenAI 兼容协议中转站）。请在 .env 设置 OPENAI_API_KEY / OPENAI_BASE_URL / LLM_MODEL。",
    );
  }
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const modelId = process.env.LLM_MODEL ?? "gpt-4o";

  return {
    apiKey,
    model: {
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
    } satisfies Model<"openai-completions">,
  };
}

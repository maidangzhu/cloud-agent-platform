// llm-fallback.ts — 在 LLM 调用层实现跨 channel / 同 channel 内降级模型 fallback。
//
// 设计要点：
// 1. 顺序：按 chain 顺序尝试每个 entry；同一 entry 内部允许 N 次重试（first-response 超时）。
// 2. 触发 fallback 的错误：5xx、429、ETIMEDOUT、ECONNREFUSED、network reset。
// 3. 不触发 fallback 的错误：400、401、403（参数/鉴权错，重试无用）。
// 4. cooldown：失败的 entry 进入冷却 60s，冷却期内直接跳过。
// 5. 上限：整链尝试不超过 maxEntries 切换 + 总重试 maxTotalAttempts（防 silent loop OOM）。
// 6. 事件：每次尝试（成功/失败/切换 entry）都通过 recordEvent 落库。
//
// 与 llm-retry 的关系：llm-retry 处理"单 entry 内首字节超时"；llm-fallback 处理"entry 整体失败后
// 切换到下一个"。fallback 在外层包裹 retry，retry 在内层处理 timeout。

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type StreamFunction,
} from "@earendil-works/pi-ai/base";
import {
  createFirstResponseRetryingStreamFn,
  DEFAULT_LLM_FIRST_RESPONSE_MAX_RETRIES,
  DEFAULT_LLM_FIRST_RESPONSE_TIMEOUT_MS,
} from "./llm-retry";
import type { ModelChainEntry } from "./model";

export const DEFAULT_LLM_FALLBACK_COOLDOWN_MS = 60_000;
export const DEFAULT_LLM_FALLBACK_MAX_TOTAL_ATTEMPTS = 8;

export interface FallbackEventOptions {
  raw?: unknown;
}

export interface FallbackDecisionOptions {
  baseStreamFn?: StreamFunction;
  /** 整条链全部失败前的总尝试上限（含每个 entry 的内部重试）。 */
  maxTotalAttempts?: number;
  /** 失败 entry 的冷却时间。 */
  cooldownMs?: number;
  /** 单 entry 内 first-response 超时（透传 llm-retry）。 */
  firstResponseTimeoutMs?: number;
  /** 单 entry 内 first-response 重试次数（透传 llm-retry）。 */
  firstResponseMaxRetries?: number;
  /** 测试钩子：替换时间源。 */
  now?: () => number;
  recordEvent?: (type: string, opts?: FallbackEventOptions) => void | Promise<void>;
  /** 测试钩子：判断某次错误是否应触发 fallback / 重试。 */
  isRetryable?: (err: unknown) => boolean;
}

/** 顶层异步错误（如 fetch reject）转 AssistantMessage。 */
function errorAssistantMessage(
  model: Model<"openai-completions"> | undefined,
  err: unknown,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: model?.provider ?? "relay",
    model: model?.id ?? "unknown",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: extractErrorMessage(err),
    timestamp: Date.now(),
  };
}

/** 从各种 err 形态里抽可读字符串，避免 `[object Object]`。
 *  兼容：Error / AssistantMessage（带 errorMessage 字段）/ 普通对象。
 *  导出是为了在测试中直接验证，避免 [object Object] 落 DB。 */
export function extractErrorMessage(err: unknown): string {
  if (!err) return "(no error)";
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const obj = err as { errorMessage?: unknown; message?: unknown; status?: unknown; code?: unknown };
    if (typeof obj.errorMessage === "string" && obj.errorMessage) return obj.errorMessage;
    if (typeof obj.message === "string" && obj.message) return obj.message;
    if (obj.status !== undefined) return `HTTP ${obj.status}`;
    if (obj.code) return `code=${obj.code}`;
    try {
      return JSON.stringify(err).slice(0, 200);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/** 默认判定：5xx / 429 / 网络错 / Timeout 触发 fallback；其他 4xx 视为不可重试。
 * 兼容两种 err 形态：
 *   - 原始 fetch / SDK error（带 status / code）
 *   - pi-ai 包装后的 AssistantMessage{ errorMessage: string }——errorMessage 通常是 "Error: 500 ..."，
 *     此时用字符串正则匹配。
 */
export function defaultIsRetryable(err: unknown): boolean {
  if (!err) return false;
  // first-response timeout 由 llm-retry 处理；若它依然冒出来，说明单 entry 内 retry 已耗尽，
  // 此时应允许 fallback 切到下一个 entry（不同 channel/model 可能更快）。
  if (err instanceof Error && err.name === "LlmFirstResponseTimeoutError") {
    return true;
  }
  // fetch / undici 错误
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    if (
      code === "ETIMEDOUT" ||
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "EAI_AGAIN"
    ) {
      return true;
    }
    const msg = err.message || "";
    if (/timeout|timed out|aborted/i.test(msg)) {
      // first response timeout 也在此命中——fallback 看到它说明上游 retry 已尽
      return true;
    }
  }
  // HTTP 状态码（裸数字 / error.status / OpenAI SDK APIError 形态）
  const status = (err as { status?: number; statusCode?: number }).status ??
    (err as { statusCode?: number }).statusCode ??
    (err as { error?: { status?: number } })?.error?.status;
  if (typeof status === "number") {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false; // 4xx (除 429) 不重试
  }
  // pi-ai 包装后的 AssistantMessage（errorMessage 是字符串）
  const errorMessage = (err as { errorMessage?: string }).errorMessage ?? "";
  if (errorMessage) {
    // 5xx 任意描述都视为可重试：抓首部出现的 "5\d\d"（前面无 4 也不在数字中间）。
    // 注意要避开 "503XXX" 这种——\b 在数字间不工作，用 lookbehind。
    if (/(?:^|[^0-9])5\d{2}(?!\d)/.test(errorMessage)) {
      return true;
    }
    if (/\b429\b|rate.?limit/i.test(errorMessage)) return true;
    // first-response timeout 错误（来自 llm-retry 用尽后）
    if (/LLM stream event within|LLM first response timeout/i.test(errorMessage)) return true;
    // pi-ai "Stream ended without finish_reason"：中转站流断开没传 finish_reason，
    // 这是上游/中转站问题，换个 channel/model 可能就好
    if (/Stream ended without finish_reason/i.test(errorMessage)) return true;
    if (/timeout|timed.?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(errorMessage)) return true;
    // 4xx 其他视为不可重试（避免无限循环）。也要避开 "503" 内的 "03"。
    if (/(?:^|[^0-9])4\d{2}(?!\d)/.test(errorMessage)) {
      return false;
    }
  }
  return false;
}

/**
 * 判断 stream 是否在首个事件前就 emit 了 error event（多数 OpenAI 兼容错误走这条路径：
 * pi-ai 内部捕获到 fetch 错误后，会推一个 {type:'error', ...} 然后 end stream）。
 * 若如此：消费掉 stream 直到 end，拿到 result.errorMessage 再决定 fallback。
 */
async function drainErrorResult(
  stream: AssistantMessageEventStream,
): Promise<AssistantMessage | undefined> {
  let sawErrorEvent = false;
  let result: AssistantMessage | undefined;
  // 同时启动 result() 与 iterator，消费完再 await result。
  const resultPromise = stream.result().then((r) => (result = r));
  for await (const event of stream) {
    if (event.type === "error") sawErrorEvent = true;
  }
  await resultPromise;
  return sawErrorEvent ? result : undefined;
}

export function createFallbackStreamFn(
  chain: ModelChainEntry[],
  opts: FallbackDecisionOptions = {},
): StreamFunction {
  if (chain.length === 0) {
    throw new Error("createFallbackStreamFn: chain is empty");
  }
  const baseStreamFn = opts.baseStreamFn ?? createFirstResponseRetryingStreamFn({
    firstResponseTimeoutMs: opts.firstResponseTimeoutMs ?? DEFAULT_LLM_FIRST_RESPONSE_TIMEOUT_MS,
    maxRetries: opts.firstResponseMaxRetries ?? DEFAULT_LLM_FIRST_RESPONSE_MAX_RETRIES,
  });
  const maxTotalAttempts = opts.maxTotalAttempts ?? DEFAULT_LLM_FALLBACK_MAX_TOTAL_ATTEMPTS;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_LLM_FALLBACK_COOLDOWN_MS;
  const now = opts.now ?? (() => Date.now());
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;
  const recordEvent = opts.recordEvent;

  // 跨调用共享冷却状态：entry.key → until timestamp
  const cooldownUntil = new Map<string, number>();

  return (_initialModel, context, options = {}) => {
    const outer = createAssistantMessageEventStream();
    const signal = options.signal;

    void (async () => {
      let lastError: unknown;
      let attempts = 0;
      let lastUsedEntry: ModelChainEntry | undefined;

      for (let i = 0; i < chain.length; i++) {
        if (signal?.aborted) break;
        const entry = chain[i];

        // 冷却检查
        const until = cooldownUntil.get(entry.key) ?? 0;
        if (until > now()) {
          await recordEvent?.("llm_entry_skipped_cooldown", {
            raw: { key: entry.key, until, remainingMs: until - now() },
          });
          continue;
        }

        await recordEvent?.("llm_entry_started", {
          raw: {
            key: entry.key,
            channel: entry.channel,
            tier: entry.tier,
            modelId: entry.model.id,
            baseUrl: entry.model.baseUrl,
            attemptInChain: i + 1,
            chainLength: chain.length,
          },
        });

        // baseStreamFn 已经是带 first-response retry 的；它对单 entry 内部会重试 maxRetries+1 次。
        // 每次外层 entry 切换会消耗多次 attempts。
        // 把当前 entry 的 apiKey 写到 options.apiKey（覆盖外层 Agent getApiKey 的解析），
        // 因为 Agent 启动时 model 是 chain[0]，调 getApiKey 只会拿到 ch1-primary 的 key。
        const innerStream = baseStreamFn(
          entry.model as Model<"openai-completions">,
          context,
          { ...options, apiKey: entry.apiKey },
        );

        let firstError: AssistantMessage | undefined;
        let isResolved = false;
        let sawAnyData = false;

        // 启动 result() 监听
        const resultPromise = innerStream.result();

        try {
          for await (const event of innerStream) {
            if (signal?.aborted) break;
            if (event.type === "error") {
              // pi-ai 内部已经把 error 包装成 AssistantMessage；记下但不立刻 fallback
              // —— 还要看是否后面有成功 event（理论上不会）。
              firstError = event.error;
              // 继续 drain 看 stream 是否还会 emit
            } else {
              sawAnyData = true;
              outer.push(event);
              // 一旦看到 start/delta 这类真实数据，停止 fallback 评估，全部转发
              if (!isResolved) {
                isResolved = true;
              }
            }
          }
        } catch (err) {
          // 流式抛错（罕见，多数错误走 error event）
          firstError = errorAssistantMessage(entry.model, err);
        }

        const result = await resultPromise;
        attempts += 1;

        // success 判定：流里有数据 + pi-ai result 自身没标 error + errorMessage 缺失。
        // 注意 pi-ai 的 "Stream ended without finish_reason" 会异步 throw，
        // 走 catch 后 push error event 并设 result.stopReason="error"，但有时候
        // 部分 chunk 已流到外层（isResolved=true）。必须三个条件都满足才算成功。
        if (
          isResolved &&
          result.stopReason !== "error" &&
          !firstError &&
          !result.errorMessage
        ) {
          await recordEvent?.("llm_entry_succeeded", {
            raw: { key: entry.key, attempts, modelId: entry.model.id },
          });
          outer.end(result);
          return;
        }

        // 如果流里有数据但 result 报 error，外部 Agent 会自己把 partial message 当成功；
        // 但我们的 fallback 责任是：在 LLM 真正出错时切到下一个 entry。
        // 此时把 firstError 用 result.errorMessage 重新填一下。
        if (!firstError && result.errorMessage) {
          firstError = errorAssistantMessage(entry.model, result.errorMessage);
        }

        // 失败路径
        lastError = firstError ?? errorAssistantMessage(entry.model, result.errorMessage);
        lastUsedEntry = entry;
        const retryable = isRetryable(lastError);
        await recordEvent?.("llm_entry_failed", {
          raw: {
            key: entry.key,
            modelId: entry.model.id,
            retryable,
            errorMessage: extractErrorMessage(lastError),
            attempts,
          },
        });

        if (!retryable) {
          // 不可重试：直接终止，避免无谓尝试其他渠道（401/403/400 等都是配置问题）
          await recordEvent?.("llm_fallback_giving_up_non_retryable", {
            raw: { key: entry.key, error: (lastError as AssistantMessage).errorMessage },
          });
          outer.push({
            type: "error",
            reason: "error",
            error: errorAssistantMessage(entry.model, lastError),
          });
          outer.end(result);
          return;
        }

        // 进入冷却 + 继续下一个 entry
        cooldownUntil.set(entry.key, now() + cooldownMs);
        await recordEvent?.("llm_entry_cooled_down", {
          raw: { key: entry.key, cooldownMs },
        });

        if (attempts >= maxTotalAttempts) {
          await recordEvent?.("llm_fallback_exhausted", {
            raw: { attempts, maxTotalAttempts, lastError: extractErrorMessage(lastError) },
          });
          outer.push({
            type: "error",
            reason: "error",
            error: errorAssistantMessage(entry.model, lastError),
          });
          outer.end(result);
          return;
        }
        // 否则继续下一个 entry
      }

      // chain 走完仍未成功
      const err = lastError ?? new Error("All LLM chain entries failed without explicit error");
      await recordEvent?.("llm_fallback_exhausted", {
        raw: { attempts, maxTotalAttempts, lastError: extractErrorMessage(err) },
      });
      outer.push({
        type: "error",
        reason: "error",
        error: errorAssistantMessage(lastUsedEntry?.model, err),
      });
    })().catch((err) => {
      outer.push({
        type: "error",
        reason: "error",
        error: errorAssistantMessage(undefined, err),
      });
    });

    return outer;
  };
}

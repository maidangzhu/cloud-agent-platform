// llm-retry.ts — 单次 LLM stream 的两层硬超时 + 单 entry 内重试。
//
// 设计要点：
// 1. firstResponseTimeoutMs：等到 stream 第一个 event（start / done / error）的最长时间。
//    超时则同 entry 内重试一次。
// 2. maxAttemptDurationMs：单次 stream 整体硬上限（首 token 之后流式慢也兜底）。
//    超时则 abort 上游 fetch 并判本次失败（由 fallback 切 entry）。
// 3. 失败语义：单 entry 内 maxRetries+1 次都失败 → 抛 LlmFirstResponseTimeoutError，
//    冒到上层 fallback 切下一个 entry（chain 维度兜底）。
// 4. 上游 stream 末尾：成功路径 outer.end(result)；失败路径 outer.end(errorMessage) —
//    显式 end 防止 fallback 的 for await 在 EventStream done 后仍被悬挂。
//
// 与 llm-fallback 的关系：retry 是 fallback 的 baseStreamFn，在单 entry 内做重试；
// fallback 在 entry 之间做切换。两者职责正交：retry 不切 channel，fallback 不重试。

import { streamSimple, type Model, type StreamFunction, type Api, type AssistantMessage } from "@earendil-works/pi-ai/base";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/base";

// 首 token（首个 event）超时默认 10s；单 entry 内只重试 1 次（共 2 次尝试）。
// 单次 stream 整体硬上限默认 5 分钟（含首 token 等待 + 流式输出）；长报告/长代码生成可占满。
export const DEFAULT_LLM_FIRST_RESPONSE_TIMEOUT_MS = 10_000;
export const DEFAULT_LLM_FIRST_RESPONSE_MAX_RETRIES = 1;
export const DEFAULT_LLM_MAX_ATTEMPT_DURATION_MS = 300_000;

export class LlmFirstResponseTimeoutError extends Error {
  readonly attempts: number;
  readonly timeoutMs: number;
  readonly attemptDurationMs: number;

  constructor(
    message: string,
    opts: { attempts: number; timeoutMs: number; attemptDurationMs?: number },
  ) {
    super(message);
    this.name = "LlmFirstResponseTimeoutError";
    this.attempts = opts.attempts;
    this.timeoutMs = opts.timeoutMs;
    this.attemptDurationMs = opts.attemptDurationMs ?? 0;
  }
}

/** Stream 整体卡死（首 token 后流式慢或上游 hang）超过 maxAttemptDurationMs 触发。 */
export class LlmAttemptDurationError extends Error {
  readonly attemptDurationMs: number;

  constructor(message: string, opts: { attemptDurationMs: number }) {
    super(message);
    this.name = "LlmAttemptDurationError";
    this.attemptDurationMs = opts.attemptDurationMs;
  }
}

export interface LlmRetryEventOptions {
  raw?: unknown;
}

export interface FirstResponseRetryOptions {
  baseStreamFn?: StreamFunction;
  /** 等待 stream 第一个 event 的最长时间。 */
  firstResponseTimeoutMs?: number;
  /** 单 entry 内重试次数（实际尝试 = maxRetries + 1）。 */
  maxRetries?: number;
  /** 单次 stream 整体硬上限。 */
  maxAttemptDurationMs?: number;
  recordEvent?: (type: string, opts?: LlmRetryEventOptions) => Promise<void> | void;
  onExhausted?: (err: LlmFirstResponseTimeoutError) => Promise<void> | void;
}

function timeoutMessage(attempts: number, timeoutMs: number): string {
  return `No LLM stream event within ${timeoutMs}ms after ${attempts} attempts`;
}

function attemptDurationMessage(attemptDurationMs: number): string {
  return `LLM stream exceeded max attempt duration of ${attemptDurationMs}ms`;
}

function errorAssistantMessage(
  model: Model<Api>,
  err: unknown,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
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
    errorMessage: err instanceof Error ? err.message : String(err),
    timestamp: Date.now(),
  };
}

function combineAbortSignals(signals: AbortSignal[]): AbortController {
  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
  };

  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    signal.addEventListener("abort", () => abort(signal), { once: true });
  }

  return controller;
}

export function createFirstResponseRetryingStreamFn(
  opts: FirstResponseRetryOptions = {},
): StreamFunction {
  const baseStreamFn = opts.baseStreamFn ?? streamSimple;
  const firstResponseTimeoutMs =
    opts.firstResponseTimeoutMs ?? DEFAULT_LLM_FIRST_RESPONSE_TIMEOUT_MS;
  const maxRetries =
    opts.maxRetries ?? DEFAULT_LLM_FIRST_RESPONSE_MAX_RETRIES;
  const maxAttemptDurationMs =
    opts.maxAttemptDurationMs ?? DEFAULT_LLM_MAX_ATTEMPT_DURATION_MS;
  const maxAttempts = maxRetries + 1;

  return (model, context, options = {}) => {
    const outer = createAssistantMessageEventStream();

    void (async () => {
      let timeoutError: LlmFirstResponseTimeoutError | undefined;
      let attemptDurationError: LlmAttemptDurationError | undefined;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const raw = {
          attempt,
          maxAttempts,
          firstResponseTimeoutMs,
          maxAttemptDurationMs,
        };
        await opts.recordEvent?.("llm_attempt_started", { raw });

        const attemptStartedAt = Date.now();
        const timeoutController = new AbortController();
        const attemptDurationController = new AbortController();
        const combinedController = options.signal
          ? combineAbortSignals([
              options.signal,
              timeoutController.signal,
              attemptDurationController.signal,
            ])
          : combineAbortSignals([
              timeoutController.signal,
              attemptDurationController.signal,
            ]);
        const upstream = baseStreamFn(model, context, {
          ...options,
          signal: combinedController.signal,
        });
        const iterator = upstream[Symbol.asyncIterator]();
        let firstTimeout: ReturnType<typeof setTimeout> | undefined;
        let attemptDurationTimer: ReturnType<typeof setTimeout> | undefined;
        let attemptDurationHit = false;

        // attempt duration 由 race 内部 timer 触发（见下方），race 出 "duration" 后
        // 上面那段会 continue 到下一 attempt。
        const first = await Promise.race([
          iterator.next().then((result) => ({ kind: "event" as const, result })),
          new Promise<{ kind: "timeout" }>((resolve) => {
            firstTimeout = setTimeout(
              () => resolve({ kind: "timeout" }),
              firstResponseTimeoutMs,
            );
          }),
          new Promise<{ kind: "duration" }>((resolve) => {
            attemptDurationTimer = setTimeout(
              () => {
                attemptDurationHit = true;
                attemptDurationController.abort(
                  new Error(`LLM attempt duration exceeded ${maxAttemptDurationMs}ms`),
                );
                resolve({ kind: "duration" });
              },
              maxAttemptDurationMs,
            );
          }),
        ]);

        if (firstTimeout) {
          clearTimeout(firstTimeout);
        }

        if (first.kind === "duration") {
          // attempt duration 触发：race 阶段就退出（无须再等 iterator.next()）。
          // 后续继续 for await 拉一下 iterator，让上游 fetch 的 reject/cleanup 反映到 result；
          // 若上游真的卡死，这里也要有上限。
          await opts.recordEvent?.("llm_attempt_duration_hit", { raw });
          attemptDurationError = new LlmAttemptDurationError(
            attemptDurationMessage(maxAttemptDurationMs),
            { attemptDurationMs: maxAttemptDurationMs },
          );
          // 给上游一个 100ms 窗口清理，否则直接进入下一 attempt
          await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
          continue;
        }

        if (first.kind === "timeout") {
          // 首 token 超时：abort 上游并判 timeout；attemptDuration 计时器保持运行，
          // 它的 abort 也会关闭 iterator。
          timeoutController.abort(
            new Error(`LLM first response timeout after ${firstResponseTimeoutMs}ms`),
          );
          await opts.recordEvent?.("llm_attempt_timeout", { raw });
          timeoutError = new LlmFirstResponseTimeoutError(
            timeoutMessage(maxAttempts, firstResponseTimeoutMs),
            {
              attempts: maxAttempts,
              timeoutMs: firstResponseTimeoutMs,
              attemptDurationMs: maxAttemptDurationMs,
            },
          );
          // 等到 maxAttemptDurationMs 再 continue，确保上游资源被释放；
          // 如果 attemptDurationController 已经因为 attemptDuration 触发而 abort，
          // 内部 fetch 会 reject、stream 会被 end —— 等一个 microtask 让清理发生。
          const remaining = maxAttemptDurationMs - (Date.now() - attemptStartedAt);
          if (remaining > 0) {
            await Promise.resolve();
          }
          if (attemptDurationTimer) clearTimeout(attemptDurationTimer);
          continue;
        }

        // 收到第一个 event
        if (attemptDurationTimer) {
          clearTimeout(attemptDurationTimer);
          attemptDurationTimer = undefined;
        }

        // 异常路径：第一个 event 就是 error 或 done
        if (first.result.done || first.result.value?.type === "error") {
          const result = await upstream.result();
          await opts.recordEvent?.("llm_attempt_succeeded", { raw });
          if (first.result.value) {
            outer.push(first.result.value);
          }
          outer.end(result);
          return;
        }

        await opts.recordEvent?.("llm_attempt_succeeded", { raw });
        if (!first.result.done) {
          outer.push(first.result.value);
        }

        // 后续 event 转发：持续重置 attempt-duration 计时器以覆盖"流式慢但还在产出"；
        // 只有"长时间没新 event"才触发 abort。
        let forwardDurationTimer: ReturnType<typeof setTimeout> | undefined;
        const scheduleForwardTimer = () => {
          if (forwardDurationTimer) clearTimeout(forwardDurationTimer);
          const elapsed = Date.now() - attemptStartedAt;
          const remaining = maxAttemptDurationMs - elapsed;
          if (remaining <= 0) {
            attemptDurationHit = true;
            return;
          }
          forwardDurationTimer = setTimeout(() => {
            attemptDurationHit = true;
            attemptDurationController.abort(
              new Error(`LLM attempt duration exceeded ${maxAttemptDurationMs}ms`),
            );
          }, remaining);
        };
        scheduleForwardTimer();

        try {
          for await (const event of {
            [Symbol.asyncIterator]: () => iterator,
          }) {
            outer.push(event);
            if (attemptDurationHit) break;
            scheduleForwardTimer();
          }
        } catch (err) {
          if (forwardDurationTimer) clearTimeout(forwardDurationTimer);
          if (attemptDurationHit) {
            attemptDurationError = new LlmAttemptDurationError(
              attemptDurationMessage(maxAttemptDurationMs),
              { attemptDurationMs: maxAttemptDurationMs },
            );
            continue;
          }
          const message = errorAssistantMessage(model, err);
          outer.push({ type: "error", reason: "error", error: message });
          outer.end(message);
          return;
        } finally {
          if (forwardDurationTimer) clearTimeout(forwardDurationTimer);
        }

        if (attemptDurationHit) {
          attemptDurationError = new LlmAttemptDurationError(
            attemptDurationMessage(maxAttemptDurationMs),
            { attemptDurationMs: maxAttemptDurationMs },
          );
          continue;
        }

        // 正常完成
        const result = await upstream.result();
        outer.end(result);
        return;
      }

      // 所有 attempt 失败
      const err =
        timeoutError ??
        attemptDurationError ??
        new LlmFirstResponseTimeoutError(
          timeoutMessage(maxAttempts, firstResponseTimeoutMs),
          { attempts: maxAttempts, timeoutMs: firstResponseTimeoutMs, attemptDurationMs: maxAttemptDurationMs },
        );
      if (timeoutError) {
        await opts.onExhausted?.(timeoutError);
      }
      const message = errorAssistantMessage(model, err);
      outer.push({ type: "error", reason: "error", error: message });
      // 显式 end outer stream —— AssistantMessageEventStream 看到 error event
      // 已经 mark done，但显式 end 防止边界情况下 fallback 的 for await 看不到 done。
      outer.end(message);
    })().catch((err) => {
      const message = errorAssistantMessage(model, err);
      outer.push({ type: "error", reason: "error", error: message });
      outer.end(message);
    });

    return outer;
  };
}

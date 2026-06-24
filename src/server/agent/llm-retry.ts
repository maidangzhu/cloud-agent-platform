import {
  createAssistantMessageEventStream,
  streamSimple,
  type Api,
  type AssistantMessage,
  type Model,
  type StreamFunction,
} from "@earendil-works/pi-ai/base";

export const DEFAULT_LLM_FIRST_RESPONSE_TIMEOUT_MS = 10_000;
export const DEFAULT_LLM_FIRST_RESPONSE_MAX_RETRIES = 2;

export class LlmFirstResponseTimeoutError extends Error {
  readonly attempts: number;
  readonly timeoutMs: number;

  constructor(
    message: string,
    opts: { attempts: number; timeoutMs: number },
  ) {
    super(message);
    this.name = "LlmFirstResponseTimeoutError";
    this.attempts = opts.attempts;
    this.timeoutMs = opts.timeoutMs;
  }
}

export interface LlmRetryEventOptions {
  raw?: unknown;
}

export interface FirstResponseRetryOptions {
  baseStreamFn?: StreamFunction;
  firstResponseTimeoutMs?: number;
  maxRetries?: number;
  recordEvent?: (type: string, opts?: LlmRetryEventOptions) => Promise<void> | void;
  onExhausted?: (err: LlmFirstResponseTimeoutError) => Promise<void> | void;
}

function timeoutMessage(attempts: number, timeoutMs: number): string {
  return `No LLM stream event within ${timeoutMs}ms after ${attempts} attempts`;
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
  const timeoutMs =
    opts.firstResponseTimeoutMs ?? DEFAULT_LLM_FIRST_RESPONSE_TIMEOUT_MS;
  const maxRetries =
    opts.maxRetries ?? DEFAULT_LLM_FIRST_RESPONSE_MAX_RETRIES;
  const maxAttempts = maxRetries + 1;

  return (model, context, options = {}) => {
    const outer = createAssistantMessageEventStream();

    void (async () => {
      let timeoutError: LlmFirstResponseTimeoutError | undefined;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const raw = { attempt, maxAttempts, timeoutMs };
        await opts.recordEvent?.("llm_attempt_started", { raw });

        const timeoutController = new AbortController();
        const combinedController = options.signal
          ? combineAbortSignals([options.signal, timeoutController.signal])
          : timeoutController;
        const upstream = baseStreamFn(model, context, {
          ...options,
          signal: combinedController.signal,
        });
        const iterator = upstream[Symbol.asyncIterator]();
        let timeout: ReturnType<typeof setTimeout> | undefined;

        const first = await Promise.race([
          iterator.next().then((result) => ({ kind: "event" as const, result })),
          new Promise<{ kind: "timeout" }>((resolve) => {
            timeout = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
          }),
        ]);

        if (timeout) {
          clearTimeout(timeout);
        }

        if (first.kind === "timeout") {
          timeoutController.abort(new Error(`LLM first response timeout after ${timeoutMs}ms`));
          await opts.recordEvent?.("llm_attempt_timeout", { raw });
          timeoutError = new LlmFirstResponseTimeoutError(
            timeoutMessage(maxAttempts, timeoutMs),
            { attempts: maxAttempts, timeoutMs },
          );
          continue;
        }

        await opts.recordEvent?.("llm_attempt_succeeded", { raw });
        if (!first.result.done) {
          outer.push(first.result.value);
        }

        for await (const event of {
          [Symbol.asyncIterator]: () => iterator,
        }) {
          outer.push(event);
        }

        const result = await upstream.result();
        outer.end(result);
        return;
      }

      const err =
        timeoutError ??
        new LlmFirstResponseTimeoutError(timeoutMessage(maxAttempts, timeoutMs), {
          attempts: maxAttempts,
          timeoutMs,
        });
      await opts.onExhausted?.(err);
      const message = errorAssistantMessage(model, err);
      outer.push({ type: "error", reason: "error", error: message });
    })().catch((err) => {
      const message = errorAssistantMessage(model, err);
      outer.push({ type: "error", reason: "error", error: message });
    });

    return outer;
  };
}

export type LlmPart = "reason" | "content";

export type LlmMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type LlmToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type LlmFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "error"
  | "unknown";

export type LlmUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type LlmProviderResult = {
  provider: "fake" | "openai-compatible";
  model: string;
  reasoning: string;
  content: string;
  toolCalls: LlmToolCall[];
  finishReason: LlmFinishReason;
  usage: LlmUsage;
  durationMs: number;
  attempts: Array<{
    key: string;
    attempt: number;
    durationMs: number;
    outcome: "success" | "retry" | "failed";
    error?: string;
  }>;
};

export type LlmModelConfig = {
  key: string;
  channel: number;
  tier: "primary" | "fallback";
  provider: "openai-compatible";
  model: string;
  baseUrl: string;
  apiKey: string;
};

export type LlmHttpTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

const MAX_CHANNELS = 20;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 1;

export function resolveLlmModelChain(params: {
  modelHint?: string;
  env?: NodeJS.ProcessEnv;
} = {}):
  | { ok: true; chain: LlmModelConfig[] }
  | { ok: false; message: string } {
  const env = params.env ?? process.env;
  const chain: LlmModelConfig[] = [];

  for (let idx = 1; idx <= MAX_CHANNELS; idx += 1) {
    const suffix = idx === 1 ? "" : String(idx);
    const apiKey = env[`OPENAI_API_KEY${suffix}`]?.trim();
    const baseUrl = env[`OPENAI_BASE_URL${suffix}`]?.trim();
    const primary = resolveModelId(params.modelHint, suffix, env);
    const fallback =
      env[`LLM_MODEL_FALLBACK${suffix}`]?.trim() || primary || undefined;

    if (!apiKey || !baseUrl || !primary) {
      if (idx === 1) {
        return {
          ok: false,
          message:
            "LLM provider is not configured: set OPENAI_API_KEY, OPENAI_BASE_URL, and LLM_MODEL",
        };
      }
      break;
    }

    chain.push({
      key: `ch${idx}-primary`,
      channel: idx,
      tier: "primary",
      provider: "openai-compatible",
      model: primary,
      baseUrl,
      apiKey,
    });
    if (fallback && fallback !== primary) {
      chain.push({
        key: `ch${idx}-fallback`,
        channel: idx,
        tier: "fallback",
        provider: "openai-compatible",
        model: fallback,
        baseUrl,
        apiKey,
      });
    }
  }

  if (chain.length === 0) {
    return {
      ok: false,
      message:
        "LLM provider is not configured: set OPENAI_API_KEY, OPENAI_BASE_URL, and LLM_MODEL",
    };
  }
  return { ok: true, chain };
}

export function normalizeFinishReason(value: unknown): LlmFinishReason {
  if (value === "stop" || value === "end_turn" || value === "complete") {
    return "stop";
  }
  if (value === "length" || value === "max_tokens") return "length";
  if (
    value === "tool_calls" ||
    value === "function_call" ||
    value === "tool_use"
  ) {
    return "tool_calls";
  }
  if (value === "content_filter" || value === "safety") {
    return "content_filter";
  }
  if (value === "error") return "error";
  return "unknown";
}

export function fakeComplete(
  messages: LlmMessage[],
  modelHint: string,
): LlmProviderResult {
  const startedAt = Date.now();
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const prompt = lastUserMessage?.content.trim() || "empty prompt";
  const reasoning = `fake reasoning for: ${prompt}`;
  const content = `fake response for: ${prompt}`;
  const toolCalls =
    modelHint === "agent-loop-step16" &&
    !messages.some((message) => message.role === "tool")
      ? fakeAgentLoopToolCalls(prompt)
      : modelHint === "pi-runtime-tools" &&
          !messages.some((message) => message.role === "tool")
        ? fakePiRuntimeToolCalls()
      : [];
  const inputTokens = estimateTokens(messages.map((message) => message.content));
  const outputTokens = estimateTokens([
    reasoning,
    content,
    ...toolCalls.map((toolCall) => toolCall.arguments),
  ]);

  return {
    provider: "fake",
    model: `fake-${modelHint}`,
    reasoning,
    content,
    toolCalls,
    finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
    durationMs: Date.now() - startedAt,
    attempts: [
      {
        key: "fake",
        attempt: 1,
        durationMs: Date.now() - startedAt,
        outcome: "success",
      },
    ],
  };
}

function fakeAgentLoopToolCalls(prompt: string): LlmToolCall[] {
  const path = "reports/agent-loop-report.md";
  const content = [
    "# Agent Loop Report",
    "",
    `Prompt: ${prompt}`,
    "",
    "This report was produced by the Step 16 fake LLM plan.",
    "",
  ].join("\n");
  return [
    {
      id: "fake-write-report",
      name: "write_file",
      arguments: JSON.stringify({
        path,
        content,
        mimeType: "text/markdown",
      }),
    },
    {
      id: "fake-create-artifact",
      name: "create_artifact",
      arguments: JSON.stringify({
        title: "Agent Loop Report",
        kind: "text",
        path,
      }),
    },
  ];
}

function fakePiRuntimeToolCalls(): LlmToolCall[] {
  return [
    {
      id: "fake-run-command",
      name: "run_command",
      arguments: JSON.stringify({
        command: "printf 'maidang-smoke\\n' > command-output.txt && cat command-output.txt",
        timeoutMs: 5000,
      }),
    },
    {
      id: "fake-list-directory",
      name: "list_directory",
      arguments: JSON.stringify({
        path: ".",
      }),
    },
    {
      id: "fake-read-file",
      name: "read_file",
      arguments: JSON.stringify({
        path: "command-output.txt",
      }),
    },
  ];
}

export async function completeWithRealProvider(params: {
  messages: LlmMessage[];
  tools?: unknown[];
  modelHint?: string;
  transport?: LlmHttpTransport;
  timeoutMs?: number;
  maxRetries?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<
  | { ok: true; result: LlmProviderResult }
  | { ok: false; status: number; code: number; message: string }
> {
  const resolved = resolveLlmModelChain({
    modelHint: params.modelHint,
    env: params.env,
  });
  if (resolved.ok === false) {
    return { ok: false, status: 500, code: 5000, message: resolved.message };
  }

  const transport = params.transport ?? defaultTransport;
  const maxRetries = params.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const overallStartedAt = Date.now();
  const attempts: LlmProviderResult["attempts"] = [];
  let lastError = "LLM provider failed";

  for (const entry of resolved.chain) {
    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      const attemptStartedAt = Date.now();
      try {
        const response = await postOpenAiChatCompletion({
          entry,
          messages: params.messages,
          tools: params.tools,
          transport,
          timeoutMs,
        });
        const result = normalizeOpenAiChatCompletion(response, entry);
        attempts.push({
          key: entry.key,
          attempt,
          durationMs: Date.now() - attemptStartedAt,
          outcome: "success",
        });
        return {
          ok: true,
          result: {
            ...result,
            durationMs: Date.now() - overallStartedAt,
            attempts,
          },
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        const isRetry = attempt <= maxRetries;
        attempts.push({
          key: entry.key,
          attempt,
          durationMs: Date.now() - attemptStartedAt,
          outcome: isRetry ? "retry" : "failed",
          error: lastError,
        });
        if (!isRetry) break;
      }
    }
  }

  return {
    ok: false,
    status: 502,
    code: 5001,
    message: lastError,
  };
}

export function normalizeOpenAiChatCompletion(
  body: unknown,
  entry: Pick<LlmModelConfig, "model">,
): Omit<LlmProviderResult, "durationMs" | "attempts"> {
  const record = asRecord(body);
  const choice = Array.isArray(record.choices)
    ? asRecord(record.choices[0])
    : {};
  const message = asRecord(choice.message);
  const usage = asRecord(record.usage);
  const reasoning = stringField(message.reasoning_content) ?? stringField(message.reasoning) ?? "";
  const content = normalizeContent(message.content);
  const toolCalls = normalizeToolCalls(message.tool_calls);
  const finishReason = normalizeFinishReason(choice.finish_reason);

  return {
    provider: "openai-compatible",
    model: stringField(record.model) ?? entry.model,
    reasoning,
    content,
    toolCalls,
    finishReason,
    usage: {
      inputTokens: numberField(usage.prompt_tokens),
      outputTokens: numberField(usage.completion_tokens),
      totalTokens: numberField(usage.total_tokens),
    },
  };
}

async function postOpenAiChatCompletion(params: {
  entry: LlmModelConfig;
  messages: LlmMessage[];
  tools?: unknown[];
  transport: LlmHttpTransport;
  timeoutMs: number;
}): Promise<unknown> {
  const url = `${params.entry.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const tools = normalizeOpenAiTools(params.tools);
  const response = await withTimeout(
    params.timeoutMs,
    (signal) =>
      params.transport(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.entry.apiKey}`,
        },
        signal,
        body: JSON.stringify({
          model: params.entry.model,
          messages: params.messages,
          ...(tools.length > 0 ? { tools } : {}),
          stream: false,
        }),
      }),
  );

  if (!response.ok) {
    throw new Error(`LLM provider returned ${response.status}`);
  }
  return response.json();
}

function normalizeOpenAiTools(tools: unknown[] | undefined): unknown[] {
  if (!tools || tools.length === 0) return [];

  return tools
    .map((tool) => {
      const record = asRecord(tool);
      if (record.type === "function") {
        const fn = asRecord(record.function);
        const name = stringField(fn.name);
        if (!name) return null;
        return {
          type: "function",
          function: {
            name,
            ...(stringField(fn.description)
              ? { description: stringField(fn.description) }
              : {}),
            parameters: asRecord(fn.parameters),
          },
        };
      }

      const name = stringField(record.name);
      if (!name) return null;
      return {
        type: "function",
        function: {
          name,
          ...(stringField(record.description)
            ? { description: stringField(record.description) }
            : {}),
          parameters: asRecord(record.parameters),
        },
      };
    })
    .filter((tool) => tool !== null);
}

async function defaultTransport(
  url: string,
  init: RequestInit,
): Promise<Response> {
  return fetch(url, init);
}

async function withTimeout<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`LLM provider timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`LLM provider timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function resolveModelId(
  modelHint: string | undefined,
  suffix: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const direct = env[`LLM_MODEL${suffix}`]?.trim();
  if (!modelHint) return direct;
  const hintKey = `LLM_MODEL_${modelHint.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}${suffix}`;
  return env[hintKey]?.trim() || direct;
}

function normalizeContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const record = asRecord(part);
      return stringField(record.text) ?? "";
    })
    .join("");
}

function normalizeToolCalls(value: unknown): LlmToolCall[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((toolCall) => {
      const record = asRecord(toolCall);
      const fn = asRecord(record.function);
      const name = stringField(fn.name);
      if (!name) return null;
      return {
        id: stringField(record.id) ?? name,
        name,
        arguments: stringField(fn.arguments) ?? "{}",
      };
    })
    .filter((toolCall): toolCall is LlmToolCall => Boolean(toolCall));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function estimateTokens(parts: string[]): number {
  const text = parts.join(" ").trim();
  if (!text) return 0;
  return text.split(/\s+/).length;
}

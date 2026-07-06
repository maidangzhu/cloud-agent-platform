export type SearchProxyResult = {
  url: string;
  title: string;
  snippet?: string;
};

export type SearchProviderResult = {
  provider: string;
  model: string;
  results: SearchProxyResult[];
  durationMs: number;
  attempts: Array<{
    attempt: number;
    durationMs: number;
    outcome: "success" | "retry" | "failed";
    status?: number;
    error?: string;
  }>;
};

export type SearchHttpTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_MS = [500, 1_500];

export function fakeSearch(query: string, limit: number): SearchProviderResult {
  const startedAt = Date.now();
  const normalizedLimit = clampLimit(limit);
  const results = Array.from({ length: normalizedLimit }, (_, index) => {
    const n = index + 1;
    return {
      url: `https://search.example.com/${encodeURIComponent(query)}/${n}`,
      title: `Fake result ${n} for ${query}`,
      snippet: `Deterministic fake search snippet ${n} for ${query}.`,
    };
  });

  return {
    provider: "search-fake",
    model: "fake-web-search",
    results,
    durationMs: Date.now() - startedAt,
    attempts: [
      {
        attempt: 1,
        durationMs: Date.now() - startedAt,
        outcome: "success",
      },
    ],
  };
}

export async function searchWithHttpProvider(params: {
  query: string;
  limit: number;
  baseUrl: string;
  apiKey?: string;
  apiKeyHeader?: string;
  provider?: string;
  model?: string;
  transport?: SearchHttpTransport;
  timeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}): Promise<
  | { ok: true; result: SearchProviderResult }
  | { ok: false; status: number; code: number; message: string; attempts: SearchProviderResult["attempts"] }
> {
  const transport = params.transport ?? defaultTransport;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = params.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffMs = params.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = params.sleep ?? defaultSleep;
  const attempts: SearchProviderResult["attempts"] = [];
  const startedAt = Date.now();
  let lastMessage = "search provider failed";

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const attemptStartedAt = Date.now();
    try {
      const response = await requestSearchProvider({
        query: params.query,
        limit: params.limit,
        baseUrl: params.baseUrl,
        apiKey: params.apiKey,
        apiKeyHeader: params.apiKeyHeader,
        transport,
        timeoutMs,
      });
      if (response.status >= 400 && response.status < 500) {
        lastMessage = `search provider returned ${response.status}`;
        attempts.push({
          attempt,
          durationMs: Date.now() - attemptStartedAt,
          outcome: "failed",
          status: response.status,
          error: lastMessage,
        });
        return { ok: false, status: 502, code: 3001, message: lastMessage, attempts };
      }
      if (!response.ok) {
        throw new SearchProviderStatusError(response.status);
      }

      const body = await response.json();
      attempts.push({
        attempt,
        durationMs: Date.now() - attemptStartedAt,
        outcome: "success",
        status: response.status,
      });
      return {
        ok: true,
        result: {
          provider: params.provider ?? "search-http",
          model: params.model ?? "web-search",
          results: normalizeSearchResponse(body).slice(0, clampLimit(params.limit)),
          durationMs: Date.now() - startedAt,
          attempts,
        },
      };
    } catch (err) {
      lastMessage = err instanceof Error ? err.message : String(err);
      const retryable = attempt <= maxRetries;
      attempts.push({
        attempt,
        durationMs: Date.now() - attemptStartedAt,
        outcome: retryable ? "retry" : "failed",
        ...(err instanceof SearchProviderStatusError ? { status: err.status } : {}),
        error: lastMessage,
      });
      if (!retryable) break;
      await sleep(backoffMs[attempt - 1] ?? backoffMs.at(-1) ?? 0);
    }
  }

  return { ok: false, status: 502, code: 3001, message: lastMessage, attempts };
}

export async function searchWithExaProvider(params: {
  query: string;
  limit: number;
  apiKey: string;
  transport?: SearchHttpTransport;
  timeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}): Promise<
  | { ok: true; result: SearchProviderResult }
  | { ok: false; status: number; code: number; message: string; attempts: SearchProviderResult["attempts"] }
> {
  const transport = params.transport ?? defaultTransport;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = params.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffMs = params.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = params.sleep ?? defaultSleep;
  const attempts: SearchProviderResult["attempts"] = [];
  const startedAt = Date.now();
  let lastMessage = "search provider failed";

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const attemptStartedAt = Date.now();
    try {
      const response = await requestExaProvider({
        query: params.query,
        limit: params.limit,
        apiKey: params.apiKey,
        transport,
        timeoutMs,
      });
      if (response.status >= 400 && response.status < 500) {
        lastMessage = `search provider returned ${response.status}`;
        attempts.push({
          attempt,
          durationMs: Date.now() - attemptStartedAt,
          outcome: "failed",
          status: response.status,
          error: lastMessage,
        });
        return { ok: false, status: 502, code: 3001, message: lastMessage, attempts };
      }
      if (!response.ok) {
        throw new SearchProviderStatusError(response.status);
      }

      const body = await response.json();
      attempts.push({
        attempt,
        durationMs: Date.now() - attemptStartedAt,
        outcome: "success",
        status: response.status,
      });
      return {
        ok: true,
        result: {
          provider: "search-exa",
          model: "exa-search",
          results: normalizeSearchResponse(body).slice(0, clampLimit(params.limit)),
          durationMs: Date.now() - startedAt,
          attempts,
        },
      };
    } catch (err) {
      lastMessage = err instanceof Error ? err.message : String(err);
      const retryable = attempt <= maxRetries;
      attempts.push({
        attempt,
        durationMs: Date.now() - attemptStartedAt,
        outcome: retryable ? "retry" : "failed",
        ...(err instanceof SearchProviderStatusError ? { status: err.status } : {}),
        error: lastMessage,
      });
      if (!retryable) break;
      await sleep(backoffMs[attempt - 1] ?? backoffMs.at(-1) ?? 0);
    }
  }

  return { ok: false, status: 502, code: 3001, message: lastMessage, attempts };
}

export function normalizeSearchResponse(body: unknown): SearchProxyResult[] {
  const record = asRecord(body);
  const rawResults =
    arrayField(record.results) ??
    arrayField(asRecord(record.web).results) ??
    arrayField(record.items) ??
    [];

  return rawResults
    .map((item) => {
      const result = asRecord(item);
      const url = stringField(result.url) ?? stringField(result.link);
      const title = stringField(result.title) ?? stringField(result.name);
      const highlight = arrayField(result.highlights)
        ?.map((value) => stringField(value))
        .find(Boolean);
      const snippet =
        stringField(result.snippet) ??
        stringField(result.description) ??
        stringField(result.summary) ??
        highlight ??
        stringField(result.text);
      if (!url || !title) return null;
      return {
        url,
        title,
        ...(snippet ? { snippet } : {}),
      };
    })
    .filter((result): result is SearchProxyResult => Boolean(result));
}

export function clampLimit(limit: number): number {
  if (!Number.isInteger(limit)) return 5;
  return Math.min(Math.max(limit, 1), 10);
}

class SearchProviderStatusError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`search provider returned ${status}`);
    this.status = status;
  }
}

async function requestSearchProvider(params: {
  query: string;
  limit: number;
  baseUrl: string;
  apiKey?: string;
  apiKeyHeader?: string;
  transport: SearchHttpTransport;
  timeoutMs: number;
}): Promise<Response> {
  const url = new URL(params.baseUrl);
  url.searchParams.set("q", params.query);
  url.searchParams.set("count", String(clampLimit(params.limit)));
  return withTimeout(params.timeoutMs, (signal) =>
    params.transport(url.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(params.apiKey
          ? { [params.apiKeyHeader ?? "x-api-key"]: params.apiKey }
          : {}),
      },
      signal,
    }),
  );
}

async function requestExaProvider(params: {
  query: string;
  limit: number;
  apiKey: string;
  transport: SearchHttpTransport;
  timeoutMs: number;
}): Promise<Response> {
  return withTimeout(params.timeoutMs, (signal) =>
    params.transport("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": params.apiKey,
      },
      body: JSON.stringify({
        query: params.query,
        numResults: clampLimit(params.limit),
        type: "fast",
        contents: {
          highlights: true,
        },
      }),
      signal,
    }),
  );
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
    controller.abort(new Error(`search provider timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`search provider timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function arrayField(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

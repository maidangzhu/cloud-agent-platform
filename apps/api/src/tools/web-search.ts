export type WebSearchResultItem = {
  url: string;
  title: string;
  snippet?: string;
};

export type WebSearchResult =
  | {
      status: "completed";
      result: {
        query: string;
        results: WebSearchResultItem[];
        provider?: string;
        model?: string;
        durationMs?: number;
        attempts?: unknown;
      };
    }
  | { status: "failed"; error: string; attempts: number };

export type WebSearchRequest = (
  path: string,
  init: RequestInit,
) => Promise<Response>;

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_MS = [500, 1_500];

export async function webSearchTool(params: {
  query: string;
  runToken: string;
  request: WebSearchRequest;
  limit?: number;
  provider?: "fake" | "http" | "exa";
  maxRetries?: number;
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}): Promise<WebSearchResult> {
  const query = params.query.trim();
  if (!query) {
    return { status: "failed", error: "web_search query is required", attempts: 0 };
  }

  const maxRetries = params.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffMs = params.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = params.sleep ?? defaultSleep;
  let lastError = "web_search failed";

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const response = await params.request("/api/search-proxy", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.runToken}`,
      },
      body: JSON.stringify({
        query,
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
        ...(params.provider ? { provider: params.provider } : {}),
      }),
    }).catch((err: unknown): Error => {
      return err instanceof Error ? err : new Error(String(err));
    });

    if (response instanceof Error) {
      lastError = response.message;
    } else if (response.status >= 500) {
      lastError = await readErrorMessage(response, `web_search failed with ${response.status}`);
    } else if (!response.ok) {
      return {
        status: "failed",
        error: await readErrorMessage(response, `web_search failed with ${response.status}`),
        attempts: attempt,
      };
    } else {
      const body = await response.json().catch((): unknown => null);
      const data = asRecord(asRecord(body).data);
      return {
        status: "completed",
        result: {
          query,
          results: normalizeResults(data.results),
          ...(stringField(data.provider) ? { provider: stringField(data.provider) } : {}),
          ...(stringField(data.model) ? { model: stringField(data.model) } : {}),
          ...(numberField(data.durationMs) !== undefined ? { durationMs: numberField(data.durationMs) } : {}),
          ...(data.attempts !== undefined ? { attempts: data.attempts } : {}),
        },
      };
    }

    if (attempt > maxRetries) {
      return { status: "failed", error: lastError, attempts: attempt };
    }
    await sleep(backoffMs[attempt - 1] ?? backoffMs.at(-1) ?? 0);
  }

  return { status: "failed", error: lastError, attempts: maxRetries + 1 };
}

function normalizeResults(value: unknown): WebSearchResultItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const url = stringField(record.url);
      const title = stringField(record.title);
      if (!url || !title) return null;
      return {
        url,
        title,
        ...(stringField(record.snippet) ? { snippet: stringField(record.snippet) } : {}),
      };
    })
    .filter((item): item is WebSearchResultItem => Boolean(item));
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch((): unknown => null);
  return stringField(asRecord(body).message) ?? fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

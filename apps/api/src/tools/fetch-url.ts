import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type FetchUrlStatus = "completed" | "failed" | "rejected";

export type FetchUrlResult =
  | {
      status: "completed";
      result: {
        url: string;
        statusCode: number;
        contentType?: string;
        title?: string;
        text?: string;
        contentHash?: string;
        size: number;
        truncated: boolean;
      };
    }
  | { status: "failed"; error: string; attempts: number }
  | { status: "rejected"; error: string };

export type FetchUrlTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export type FetchUrlResolver = (
  hostname: string,
) => Promise<Array<{ address: string; family: 4 | 6 }>>;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_BACKOFF_MS = [500];

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata",
]);

export async function fetchUrlTool(params: {
  url: string;
  transport?: FetchUrlTransport;
  timeoutMs?: number;
  maxBytes?: number;
  maxRetries?: number;
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  resolveHost?: FetchUrlResolver;
}): Promise<FetchUrlResult> {
  const guard = validateFetchUrl(params.url);
  if (!guard.ok) return { status: "rejected", error: guard.message };

  const transport = params.transport ?? defaultTransport;
  const resolveHost = params.resolveHost ?? (params.transport ? undefined : defaultResolveHost);
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = params.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRetries = params.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffMs = params.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = params.sleep ?? defaultSleep;
  let lastError = "fetch_url failed";

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    try {
      if (resolveHost && !isIP(stripBrackets(guard.url.hostname))) {
        const resolved = await resolveHost(guard.url.hostname);
        const blocked = resolved.find((entry) => isBlockedIPAddress(entry.address));
        if (blocked) {
          return {
            status: "rejected",
            error: `SSRF guard rejected resolved private address ${blocked.address}`,
          };
        }
      }

      const response = await withTimeout(timeoutMs, (signal) =>
        transport(guard.url.toString(), {
          method: "GET",
          headers: { accept: "*/*" },
          signal,
        }),
      );

      if (response.status >= 400 && response.status < 500) {
        return {
          status: "rejected",
          error: `fetch_url received non-retryable status ${response.status}`,
        };
      }
      if (response.status >= 500) {
        throw new Error(`fetch_url received retryable status ${response.status}`);
      }

      const contentType = response.headers.get("content-type") ?? undefined;
      const bytes = await response.arrayBuffer();
      const full = new Uint8Array(bytes);
      const truncated = full.byteLength > maxBytes;
      const kept = truncated ? full.slice(0, maxBytes) : full;
      const text = isTextContentType(contentType)
        ? new TextDecoder().decode(kept)
        : undefined;

      return {
        status: "completed",
        result: {
          url: guard.url.toString(),
          statusCode: response.status,
          ...(contentType ? { contentType } : {}),
          ...(text ? { text, title: extractTitle(text) } : {}),
          contentHash: sha256(kept),
          size: full.byteLength,
          truncated,
        },
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt > maxRetries) {
        return { status: "failed", error: lastError, attempts: attempt };
      }
      await sleep(backoffMs[attempt - 1] ?? backoffMs.at(-1) ?? 0);
    }
  }

  return { status: "failed", error: lastError, attempts: maxRetries + 1 };
}

export function validateFetchUrl(
  value: string,
): { ok: true; url: URL } | { ok: false; message: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: "fetch_url URL is invalid" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: "fetch_url only allows http/https URLs" };
  }

  const host = stripBrackets(url.hostname.toLowerCase());
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, message: "SSRF guard rejected localhost" };
  }
  if (METADATA_HOSTS.has(host)) {
    return { ok: false, message: "SSRF guard rejected metadata host" };
  }

  const ipVersion = isIP(host);
  if (ipVersion === 4 && isBlockedIPv4(host)) {
    return { ok: false, message: "SSRF guard rejected private address" };
  }
  if (ipVersion === 6 && isBlockedIPv6(host)) {
    return { ok: false, message: "SSRF guard rejected private address" };
  }

  return { ok: true, url };
}

export function isBlockedIPAddress(address: string): boolean {
  const host = stripBrackets(address.toLowerCase());
  const ipVersion = isIP(host);
  if (ipVersion === 4) return isBlockedIPv4(host);
  if (ipVersion === 6) return isBlockedIPv6(host);
  return true;
}

export function isTextContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const type = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type === "application/xhtml+xml" ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.") ||
    normalized.startsWith("::ffff:169.254.")
  );
}

async function defaultTransport(
  url: string,
  init: RequestInit,
): Promise<Response> {
  return fetch(url, init);
}

async function defaultResolveHost(
  hostname: string,
): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const addresses = await lookup(hostname, { all: true });
  return addresses
    .filter((entry): entry is { address: string; family: 4 | 6 } =>
      entry.family === 4 || entry.family === 6,
    )
    .map((entry) => ({ address: entry.address, family: entry.family }));
}

async function withTimeout<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`fetch_url timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`fetch_url timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function extractTitle(text: string): string | undefined {
  const match = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1]?.replace(/\s+/g, " ").trim();
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
}

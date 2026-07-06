import { Hono } from "hono";
import { prisma } from "@cap/db";
import { extractBearerRunToken, verifyRunToken } from "../run/run-token";
import { isTerminalStatus, type RunStatus } from "../run/transitions";
import { createSource } from "../sources/store";
import { recordLLMUsage } from "../usage/store";
import {
  clampLimit,
  fakeSearch,
  searchWithExaProvider,
  searchWithHttpProvider,
  type SearchProviderResult,
} from "./provider";

type AuthenticatedRun = {
  id: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  status: RunStatus;
};

export const searchRoutes = new Hono();

searchRoutes.post("/api/search-proxy", async (c) => {
  const body = await readJsonObject(c.req.raw);
  if (!body) {
    return c.json({ code: 1001, message: "bad request", data: null }, 400);
  }

  const run = await authenticateRunToken(c.req.header("authorization"), body);
  if (run instanceof Response) return run;

  if (isTerminalStatus(run.status)) {
    return c.json({ code: 2003, message: "run is terminal", data: null }, 409);
  }
  if (run.status === "waiting_for_input") {
    return c.json(
      { code: 2005, message: "run is not accepting search calls", data: null },
      409,
    );
  }

  const parsed = parseSearchProxyBody(body);
  if (!parsed.ok) {
    return c.json({ code: 1006, message: parsed.message, data: null }, 400);
  }

  const searched = await runSearchProvider(
    parsed.query,
    parsed.limit,
    parsed.provider,
  );
  if (!searched.ok) {
    return jsonResponse(searched.code, searched.message, searched.status);
  }

  await Promise.all([
    recordUsageBestEffort(run.id, searched.result),
    recordSourcesBestEffort(run, searched.result),
  ]);

  return c.json({
    code: 0,
    message: "ok",
    data: {
      results: searched.result.results,
      provider: searched.result.provider,
      model: searched.result.model,
      durationMs: searched.result.durationMs,
      attempts: searched.result.attempts,
    },
  });
});

async function runSearchProvider(
  query: string,
  limit: number,
  requestedProvider: "fake" | "http" | "exa",
): Promise<
  | { ok: true; result: SearchProviderResult }
  | { ok: false; status: number; code: number; message: string }
> {
  const provider =
    requestedProvider === "fake"
      ? process.env.SEARCH_PROXY_PROVIDER ?? "fake"
      : requestedProvider;

  if (provider === "exa") {
    const apiKey = process.env.EXA_API_KEY?.trim();
    if (!apiKey) {
      return {
        ok: false,
        status: 500,
        code: 3001,
        message: "EXA_API_KEY is required",
      };
    }
    const result = await searchWithExaProvider({
      query,
      limit,
      apiKey,
      backoffMs: parseBackoffMs(process.env.SEARCH_PROXY_BACKOFF_MS),
    });
    return result.ok
      ? result
      : {
          ok: false,
          status: result.status,
          code: result.code,
          message: result.message,
        };
  }

  if (provider === "http") {
    const baseUrl = process.env.SEARCH_PROXY_BASE_URL?.trim();
    if (!baseUrl) {
      return {
        ok: false,
        status: 500,
        code: 3001,
        message: "SEARCH_PROXY_BASE_URL is required",
      };
    }
    const result = await searchWithHttpProvider({
      query,
      limit,
      baseUrl,
      apiKey: process.env.SEARCH_PROXY_API_KEY?.trim(),
      backoffMs: parseBackoffMs(process.env.SEARCH_PROXY_BACKOFF_MS),
    });
    return result.ok
      ? result
      : {
          ok: false,
          status: result.status,
          code: result.code,
          message: result.message,
        };
  }

  return { ok: true, result: fakeSearch(query, limit) };
}

function parseSearchProxyBody(
  body: Record<string, unknown>,
):
  | { ok: true; query: string; limit: number; provider: "fake" | "http" | "exa" }
  | { ok: false; message: string } {
  if (typeof body.query !== "string" || body.query.trim().length === 0) {
    return { ok: false, message: "query is required" };
  }
  const limit =
    body.limit === undefined
      ? 5
      : typeof body.limit === "number"
        ? body.limit
        : Number.NaN;
  if (!Number.isInteger(limit)) {
    return { ok: false, message: "limit must be an integer" };
  }
  const provider =
    body.provider === "http" || body.provider === "exa"
      ? body.provider
      : "fake";
  return { ok: true, query: body.query.trim(), limit: clampLimit(limit), provider };
}

async function recordUsageBestEffort(
  runId: string,
  result: SearchProviderResult,
): Promise<void> {
  try {
    await recordLLMUsage({
      runId,
      provider: result.provider,
      model: result.model,
      durationMs: result.durationMs,
    });
  } catch (err) {
    console.warn("[search-proxy] failed to record usage", {
      runId,
      provider: result.provider,
      model: result.model,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function recordSourcesBestEffort(
  run: AuthenticatedRun,
  result: SearchProviderResult,
): Promise<void> {
  try {
    await Promise.all(
      result.results.map((searchResult) =>
        createSource({
          workspaceId: run.workspaceId,
          runId: run.id,
          input: {
            kind: "search_result",
            uri: searchResult.url,
            title: searchResult.title,
            metadata: searchResult.snippet
              ? { snippet: searchResult.snippet }
              : undefined,
          },
        }),
      ),
    );
  } catch (err) {
    console.warn("[search-proxy] failed to record sources", {
      runId: run.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function authenticateRunToken(
  authorizationHeader: string | undefined,
  body: Record<string, unknown>,
): Promise<AuthenticatedRun | Response> {
  const token = extractBearerRunToken(authorizationHeader);
  if (!token) {
    return jsonResponse(1002, "unauthorized", 401);
  }

  const bodyRunId = typeof body.runId === "string" ? body.runId : undefined;
  const verified = verifyRunToken(token, {
    expected: bodyRunId ? { runId: bodyRunId } : undefined,
  });
  if (!verified.ok) {
    return jsonResponse(2002, "run token invalid", 401);
  }

  const run = await prisma.agentRun.findUnique({
    where: { id: verified.claims.runId },
  });
  if (
    !run ||
    run.userId !== verified.claims.userId ||
    run.workspaceId !== verified.claims.workspaceId ||
    run.threadId !== verified.claims.threadId
  ) {
    return jsonResponse(2002, "run token invalid", 401);
  }

  return {
    id: run.id,
    workspaceId: run.workspaceId,
    threadId: run.threadId,
    userId: run.userId,
    status: run.status as RunStatus,
  };
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const parsed = await request.json().catch((): unknown => null);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function jsonResponse(code: number, message: string, status: number): Response {
  return new Response(JSON.stringify({ code, message, data: null }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parseBackoffMs(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map((part) => Number(part.trim()));
  return parts.every((part) => Number.isFinite(part) && part >= 0)
    ? parts
    : undefined;
}

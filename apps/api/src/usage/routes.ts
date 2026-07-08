import { Hono } from "hono";
import { requireUser } from "../require-user.js";
import { listUsageRecords } from "./store.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export const usageRoutes = new Hono();

usageRoutes.get("/api/usage/records", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;

  const parsed = parseUsageQuery({
    runId: c.req.query("runId"),
    provider: c.req.query("provider"),
    model: c.req.query("model"),
    limit: c.req.query("limit"),
    offset: c.req.query("offset"),
  });
  if (parsed.ok === false) {
    return c.json({ code: 1006, message: parsed.message, data: null }, 400);
  }

  const records = await listUsageRecords({
    userId: user.id,
    ...parsed.query,
  });

  return c.json({
    code: 0,
    message: "ok",
    data: {
      records,
      pagination: {
        limit: parsed.query.limit,
        offset: parsed.query.offset,
        ...(records.length === parsed.query.limit
          ? { nextOffset: parsed.query.offset + parsed.query.limit }
          : {}),
      },
    },
  });
});

function parseUsageQuery(input: {
  runId?: string;
  provider?: string;
  model?: string;
  limit?: string;
  offset?: string;
}):
  | {
      ok: true;
      query: {
        runId?: string;
        provider?: string;
        model?: string;
        limit: number;
        offset: number;
      };
    }
  | { ok: false; message: string } {
  const limit = parseOptionalInteger(input.limit, DEFAULT_LIMIT);
  if (limit === null || limit < 1 || limit > MAX_LIMIT) {
    return { ok: false, message: `limit must be between 1 and ${MAX_LIMIT}` };
  }

  const offset = parseOptionalInteger(input.offset, 0);
  if (offset === null || offset < 0) {
    return { ok: false, message: "offset must be a non-negative integer" };
  }

  return {
    ok: true,
    query: {
      ...(input.runId?.trim() ? { runId: input.runId.trim() } : {}),
      ...(input.provider?.trim() ? { provider: input.provider.trim() } : {}),
      ...(input.model?.trim() ? { model: input.model.trim() } : {}),
      limit,
      offset,
    },
  };
}

function parseOptionalInteger(
  value: string | undefined,
  fallback: number,
): number | null {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value)) return null;
  return Number(value);
}

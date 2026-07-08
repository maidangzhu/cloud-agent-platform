import { Hono } from "hono";
import { sweepStaleRuns } from "./run-sweep.js";
import { sweepOrphanResources } from "./resource-sweep.js";

type SweepAuthResult =
  | { ok: true }
  | { ok: false; message: string };

type SweepEnv = {
  CRON_SECRET?: string;
  NODE_ENV?: string;
  VERCEL_ENV?: string;
};

export const sweepRoutes = new Hono();

sweepRoutes.get("/api/sweep", async (c) => {
  const auth = authorizeSweep(c.req.header("authorization"), process.env);
  if (auth.ok === false) {
    return c.json({ code: 1002, message: auth.message, data: null }, 401);
  }

  const startedAt = new Date();
  const startedMs = Date.now();
  try {
    const runs = await sweepStaleRuns();
    const resources = await sweepOrphanResources({
      stopSandboxProvider: true,
    });
    const completedAt = new Date();

    return c.json({
      code: 0,
      message: "ok",
      data: {
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: Date.now() - startedMs,
        runs,
        resources,
      },
    });
  } catch (error) {
    console.error("sweep failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return c.json({ code: 5000, message: "sweep failed", data: null }, 500);
  }
});

export function authorizeSweep(
  authorizationHeader: string | undefined,
  env: SweepEnv,
): SweepAuthResult {
  const secret = env.CRON_SECRET?.trim();
  if (secret) {
    return extractBearerToken(authorizationHeader) === secret
      ? { ok: true }
      : { ok: false, message: "unauthorized" };
  }

  if (
    env.NODE_ENV === "production" ||
    env.VERCEL_ENV === "production" ||
    env.VERCEL_ENV === "preview"
  ) {
    return { ok: false, message: "CRON_SECRET is required" };
  }

  return { ok: true };
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token, extra] = header.trim().split(/\s+/);
  if (extra || scheme !== "Bearer" || !token) return null;
  return token;
}

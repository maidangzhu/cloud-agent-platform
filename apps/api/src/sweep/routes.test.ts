import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./run-sweep", () => ({
  sweepStaleRuns: vi.fn(),
}));

vi.mock("./resource-sweep", () => ({
  sweepOrphanResources: vi.fn(),
}));

import { createApp } from "../app.js";
import { sweepStaleRuns } from "./run-sweep.js";
import { sweepOrphanResources } from "./resource-sweep.js";

const mockedSweepStaleRuns = vi.mocked(sweepStaleRuns);
const mockedSweepOrphanResources = vi.mocked(sweepOrphanResources);

const originalEnv = { ...process.env };

describe("GET /api/sweep", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it("runs stale run and orphan resource sweeps in local/test env without CRON_SECRET", async () => {
    delete process.env.CRON_SECRET;
    process.env.NODE_ENV = "test";
    delete process.env.VERCEL_ENV;
    mockedSweepStaleRuns.mockResolvedValue({
      scanned: 2,
      transitioned: [
        {
          runId: "run_1",
          fromStatus: "running",
          toStatus: "interrupted",
          applied: true,
        },
      ],
    });
    mockedSweepOrphanResources.mockResolvedValue({
      sandboxInstancesStopped: 1,
      redisStreams: { scanned: 1, deleted: 1, runIds: ["run_1"] },
    });

    const res = await createApp().request("/api/sweep");

    expect(res.status).toBe(200);
    expect(mockedSweepStaleRuns).toHaveBeenCalledTimes(1);
    expect(mockedSweepOrphanResources).toHaveBeenCalledWith({
      stopSandboxProvider: true,
    });
    const body = await res.json();
    expect(body.code).toBe(0);
    expect(body.data.runs.scanned).toBe(2);
    expect(body.data.resources.sandboxInstancesStopped).toBe(1);
    expect(body.data.durationMs).toEqual(expect.any(Number));
  });

  it("requires a matching bearer token when CRON_SECRET is configured", async () => {
    process.env.CRON_SECRET = "sweep-secret";
    mockedSweepStaleRuns.mockResolvedValue({ scanned: 0, transitioned: [] });
    mockedSweepOrphanResources.mockResolvedValue({
      sandboxInstancesStopped: 0,
      redisStreams: { scanned: 0, deleted: 0, runIds: [] },
    });

    const unauthorized = await createApp().request("/api/sweep");
    expect(unauthorized.status).toBe(401);

    const wrong = await createApp().request("/api/sweep", {
      headers: { authorization: "Bearer wrong" },
    });
    expect(wrong.status).toBe(401);

    const ok = await createApp().request("/api/sweep", {
      headers: { authorization: "Bearer sweep-secret" },
    });
    expect(ok.status).toBe(200);
    expect(mockedSweepStaleRuns).toHaveBeenCalledTimes(1);
  });

  it("does not allow deployed production sweep without CRON_SECRET", async () => {
    delete process.env.CRON_SECRET;
    process.env.NODE_ENV = "production";
    process.env.VERCEL_ENV = "production";

    const res = await createApp().request("/api/sweep");

    expect(res.status).toBe(401);
    expect(mockedSweepStaleRuns).not.toHaveBeenCalled();
    expect(mockedSweepOrphanResources).not.toHaveBeenCalled();
  });

  it("does not allow deployed preview sweep without CRON_SECRET", async () => {
    delete process.env.CRON_SECRET;
    process.env.NODE_ENV = "test";
    process.env.VERCEL_ENV = "preview";

    const res = await createApp().request("/api/sweep");

    expect(res.status).toBe(401);
    expect(mockedSweepStaleRuns).not.toHaveBeenCalled();
    expect(mockedSweepOrphanResources).not.toHaveBeenCalled();
  });
});

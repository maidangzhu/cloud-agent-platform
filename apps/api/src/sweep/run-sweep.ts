import { prisma } from "@cap/db";
import { releaseWorkspaceSandboxForRun } from "../sandbox/workspace-sandbox";
import { transitionRun } from "../run/transition-run";
import type { RunStatus } from "../run/transitions";

export type SweepStaleRunsOptions = {
  now?: Date;
  provisioningTimeoutMs?: number;
  cancelTimeoutMs?: number;
  limit?: number;
  runIds?: string[];
  releaseSandbox?: (runId: string) => Promise<unknown>;
};

export type SweepRunResult = {
  runId: string;
  fromStatus: RunStatus;
  toStatus: RunStatus;
  applied: boolean;
};

export type SweepStaleRunsResult = {
  scanned: number;
  transitioned: SweepRunResult[];
};

type SweepCandidate = {
  id: string;
  status: string;
  maxDurationSec: number;
  createdAt: Date;
  lastHeartbeatAt: Date | null;
  updatedAt: Date;
};

const DEFAULT_PROVISIONING_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CANCEL_TIMEOUT_MS = 60 * 1000;
const DEFAULT_LIMIT = 100;

export async function sweepStaleRuns(
  options: SweepStaleRunsOptions = {},
): Promise<SweepStaleRunsResult> {
  const now = options.now ?? new Date();
  const provisioningTimeoutMs =
    options.provisioningTimeoutMs ?? DEFAULT_PROVISIONING_TIMEOUT_MS;
  const cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const releaseSandbox = options.releaseSandbox ?? releaseWorkspaceSandboxForRun;

  const candidates = await prisma.agentRun.findMany({
    where: {
      ...(options.runIds ? { id: { in: options.runIds } } : {}),
      status: { in: ["running", "provisioning_sandbox", "cancel_requested"] },
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });

  const transitioned: SweepRunResult[] = [];
  for (const candidate of candidates) {
    const target = getStaleRunTarget(candidate, {
      now,
      provisioningTimeoutMs,
      cancelTimeoutMs,
    });
    if (!target) continue;

    const result = await transitionRun(candidate.id, target, [
      candidate.status as RunStatus,
    ]);
    const sweepResult: SweepRunResult = {
      runId: candidate.id,
      fromStatus: candidate.status as RunStatus,
      toStatus: target,
      applied: result.applied,
    };
    transitioned.push(sweepResult);

    if (result.applied) {
      await releaseSandbox(candidate.id);
    }
  }

  return { scanned: candidates.length, transitioned };
}

export function getStaleRunTarget(
  candidate: SweepCandidate,
  options: {
    now: Date;
    provisioningTimeoutMs: number;
    cancelTimeoutMs: number;
  },
): RunStatus | null {
  const status = candidate.status as RunStatus;
  if (status === "running") {
    const heartbeatAt = candidate.lastHeartbeatAt ?? candidate.createdAt;
    return isOlderThan(heartbeatAt, options.now, candidate.maxDurationSec * 1000)
      ? "interrupted"
      : null;
  }

  if (status === "provisioning_sandbox") {
    const lastProgressAt = candidate.lastHeartbeatAt ?? candidate.createdAt;
    return isOlderThan(lastProgressAt, options.now, options.provisioningTimeoutMs)
      ? "timeout"
      : null;
  }

  if (status === "cancel_requested") {
    return isOlderThan(candidate.updatedAt, options.now, options.cancelTimeoutMs)
      ? "cancelled"
      : null;
  }

  return null;
}

function isOlderThan(value: Date, now: Date, thresholdMs: number): boolean {
  return now.getTime() - value.getTime() > thresholdMs;
}

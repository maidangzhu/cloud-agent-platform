import { cleanupExpiredRunStreams } from "../redis/streams.js";
import { sweepOrphanWorkspaceSandboxes } from "../sandbox/workspace-sandbox.js";

export type SweepOrphanResourcesOptions = {
  now?: Date;
  sandboxOlderThanMs?: number;
  stopSandboxProvider?: boolean;
  redisStreamGraceMs?: number;
  redisBatchSize?: number;
};

export type SweepOrphanResourcesResult = {
  sandboxInstancesStopped: number;
  redisStreams: {
    scanned: number;
    deleted: number;
    runIds: string[];
  };
};

const DEFAULT_SANDBOX_ORPHAN_GRACE_MS = 60 * 60 * 1000;

export async function sweepOrphanResources(
  options: SweepOrphanResourcesOptions = {},
): Promise<SweepOrphanResourcesResult> {
  const now = options.now ?? new Date();
  const sandboxInstancesStopped = await sweepOrphanWorkspaceSandboxes({
    olderThan: new Date(
      now.getTime() -
        (options.sandboxOlderThanMs ?? DEFAULT_SANDBOX_ORPHAN_GRACE_MS),
    ),
    stopProvider: options.stopSandboxProvider ?? false,
  });
  const redisStreams = await cleanupExpiredRunStreams({
    now,
    ...(options.redisStreamGraceMs !== undefined
      ? { graceMs: options.redisStreamGraceMs }
      : {}),
    ...(options.redisBatchSize !== undefined
      ? { batchSize: options.redisBatchSize }
      : {}),
  });

  return { sandboxInstancesStopped, redisStreams };
}

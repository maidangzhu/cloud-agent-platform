import Redis from "ioredis";
import { prisma } from "@cap/db";
import { TERMINAL_RUN_STATUSES } from "../run/transitions.js";

export type StreamChunkType = "thinking" | "content";

export type RunStreamEntry = {
  id: string;
  chunk: string;
  streamType: StreamChunkType;
};

const DEFAULT_MAXLEN = 1000;
const DEFAULT_TTL_SECONDS = 60 * 60;
const DEFAULT_CLEANUP_GRACE_MS = 60 * 60 * 1000;
const DEFAULT_CLEANUP_BATCH_SIZE = 100;

let redis: Redis | null = null;

export function runStreamKey(runId: string): string {
  return `run:${runId}:stream`;
}

export function getRedisClient(): Redis {
  if (redis) return redis;
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL is required");
  }
  redis = new Redis(url, {
    maxRetriesPerRequest: 3,
  });
  return redis;
}

export async function disconnectRedis(): Promise<void> {
  if (!redis) return;
  redis.disconnect();
  redis = null;
}

export async function addRunStreamChunk(params: {
  runId: string;
  chunk: string;
  streamType: StreamChunkType;
  ttlSeconds?: number;
}): Promise<string> {
  const client = getRedisClient();
  const key = runStreamKey(params.runId);
  const id = await client.xadd(
    key,
    "MAXLEN",
    "~",
    DEFAULT_MAXLEN,
    "*",
    "chunk",
    params.chunk,
    "type",
    params.streamType,
  );
  if (!id) {
    throw new Error("Redis XADD did not return an entry id");
  }
  await client.expire(key, params.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  return id;
}

export async function readRunStream(params: {
  runId: string;
  cursor?: string;
  blockMs?: number;
  count?: number;
}): Promise<RunStreamEntry[]> {
  const client = getRedisClient();
  const key = runStreamKey(params.runId);
  const reply = await client.xread(
    "COUNT",
    params.count ?? 100,
    "BLOCK",
    params.blockMs ?? 0,
    "STREAMS",
    key,
    params.cursor ?? "0",
  );
  if (!reply) return [];
  return reply.flatMap(([, entries]) =>
    entries.map(([id, fields]) => parseRunStreamEntry(id, fields)),
  );
}

export async function deleteRunStream(runId: string): Promise<void> {
  await getRedisClient().del(runStreamKey(runId));
}

export async function cleanupExpiredRunStreams(params: {
  now?: Date;
  graceMs?: number;
  batchSize?: number;
  runIds?: string[];
} = {}): Promise<{ scanned: number; deleted: number; runIds: string[] }> {
  const now = params.now ?? new Date();
  const graceMs = params.graceMs ?? DEFAULT_CLEANUP_GRACE_MS;
  const cutoff = new Date(now.getTime() - graceMs);

  const expiredRuns = await prisma.agentRun.findMany({
    where: {
      status: { in: [...TERMINAL_RUN_STATUSES] },
      completedAt: { lte: cutoff },
      ...(params.runIds ? { id: { in: params.runIds } } : {}),
    },
    orderBy: { completedAt: "asc" },
    take: params.batchSize ?? DEFAULT_CLEANUP_BATCH_SIZE,
    select: { id: true },
  });
  const runIds = expiredRuns.map((run) => run.id);
  if (runIds.length === 0) {
    return { scanned: 0, deleted: 0, runIds: [] };
  }

  const deleted = await getRedisClient().del(...runIds.map(runStreamKey));
  return { scanned: runIds.length, deleted, runIds };
}

function parseRunStreamEntry(id: string, fields: string[]): RunStreamEntry {
  const record: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (key && value !== undefined) record[key] = value;
  }
  return {
    id,
    chunk: record.chunk ?? "",
    streamType: record.type === "content" ? "content" : "thinking",
  };
}

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cap/db";
import {
  addRunStreamChunk,
  cleanupExpiredRunStreams,
  deleteRunStream,
  disconnectRedis,
  readRunStream,
} from "./streams";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const HAS_REDIS = Boolean(process.env.REDIS_URL);

describe.skipIf(!HAS_DB || !HAS_REDIS)(
  "expired run Redis stream cleanup（真实 Neon + Redis Streams，见 Step 13.3）",
  () => {
    const createdRunIds: string[] = [];
    const createdThreadIds: string[] = [];
    const createdWorkspaceIds: string[] = [];
    const createdUserIds: string[] = [];

    afterAll(async () => {
      for (const runId of createdRunIds) {
        await deleteRunStream(runId).catch(() => undefined);
      }
      await prisma.runEvent.deleteMany({
        where: { runId: { in: createdRunIds } },
      });
      await prisma.runToolCall.deleteMany({
        where: { runId: { in: createdRunIds } },
      });
      await prisma.agentRun.deleteMany({
        where: { id: { in: createdRunIds } },
      });
      await prisma.thread.deleteMany({
        where: { id: { in: createdThreadIds } },
      });
      await prisma.workspace.deleteMany({
        where: { id: { in: createdWorkspaceIds } },
      });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      await disconnectRedis();
      await prisma.$disconnect();
    });

    async function createTerminalRun(completedAt: Date): Promise<string> {
      const userId = randomUUID();
      const workspaceId = randomUUID();
      const threadId = randomUUID();
      const runId = randomUUID();
      createdUserIds.push(userId);
      createdWorkspaceIds.push(workspaceId);
      createdThreadIds.push(threadId);
      createdRunIds.push(runId);

      await prisma.user.create({
        data: {
          id: userId,
          email: `it-stream-cleanup-${runId}@example.com`,
          name: "Stream Cleanup Test User",
        },
      });
      await prisma.workspace.create({
        data: {
          id: workspaceId,
          ownerUserId: userId,
          title: `IT-StreamCleanupWs-${runId}`,
        },
      });
      await prisma.thread.create({
        data: {
          id: threadId,
          workspaceId,
          title: "IT-StreamCleanupThread",
        },
      });
      await prisma.agentRun.create({
        data: {
          id: runId,
          workspaceId,
          threadId,
          userId,
          prompt: "cleanup expired stream",
          status: "completed",
          startedAt: completedAt,
          completedAt,
        },
      });

      return runId;
    }

    it("deletes stream key for terminal run older than grace and is idempotent", async () => {
      const now = new Date("2026-07-06T00:00:00.000Z");
      const runId = await createTerminalRun(
        new Date(now.getTime() - 2 * 60 * 60 * 1000),
      );
      await addRunStreamChunk({
        runId,
        chunk: "expired-token",
        streamType: "thinking",
      });

      await expect(
        readRunStream({ runId, cursor: "0", blockMs: 100 }),
      ).resolves.toHaveLength(1);

      const first = await cleanupExpiredRunStreams({
        now,
        graceMs: 60 * 60 * 1000,
        runIds: [runId],
      });
      expect(first).toEqual({ scanned: 1, deleted: 1, runIds: [runId] });
      await expect(
        readRunStream({ runId, cursor: "0", blockMs: 100 }),
      ).resolves.toEqual([]);

      const second = await cleanupExpiredRunStreams({
        now,
        graceMs: 60 * 60 * 1000,
        runIds: [runId],
      });
      expect(second).toEqual({ scanned: 1, deleted: 0, runIds: [runId] });
    });
  },
);

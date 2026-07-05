import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cap/db";
import { INGEST_SEQ_CONFLICT, insertRunEvent } from "./event-store";

// 连真实 Neon Postgres，不 mock。对应 docs/testing-strategy.md §4.5
// unit 1-3；这些断言依赖 RunEvent 的真实 unique(runId, seq) 约束和
// Prisma 写入行为，所以放在 integration suite 里执行。
const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)(
  "RunEvent event store ingest 基础（真实 Neon，见 Step 6.4）",
  () => {
    const createdRunIds: string[] = [];

    afterAll(async () => {
      if (createdRunIds.length > 0) {
        await prisma.runEvent.deleteMany({
          where: { runId: { in: createdRunIds } },
        });
        await prisma.agentRun.deleteMany({
          where: { id: { in: createdRunIds } },
        });
      }
      await prisma.$disconnect();
    });

    async function createTestRun() {
      const id = randomUUID();
      const run = await prisma.agentRun.create({
        data: {
          id,
          workspaceId: `it-event-ws-${id}`,
          threadId: `it-event-thread-${id}`,
          userId: `it-event-user-${id}`,
          prompt: "event store test placeholder",
          status: "running",
        },
      });
      createdRunIds.push(run.id);
      return run;
    }

    it("seq monotonicity enforced within a run", async () => {
      const run = await createTestRun();

      await expect(
        insertRunEvent({
          runId: run.id,
          seq: 1,
          type: "run_created",
          payload: null,
        }),
      ).resolves.toMatchObject({ ok: true, idempotent: false });

      await expect(
        insertRunEvent({
          runId: run.id,
          seq: 3,
          type: "agent_started",
          payload: null,
        }),
      ).resolves.toMatchObject({ ok: true, idempotent: false });

      await expect(
        insertRunEvent({
          runId: run.id,
          seq: 2,
          type: "sandbox_ready",
          payload: null,
        }),
      ).resolves.toMatchObject({ ok: false, code: INGEST_SEQ_CONFLICT });
    });

    it("duplicate same payload + same seq is idempotent and creates no duplicate row", async () => {
      const run = await createTestRun();
      const event = {
        runId: run.id,
        seq: 1,
        type: "agent_message" as const,
        content: "Done",
        payload: { messageId: "msg_1" },
      };

      const first = await insertRunEvent(event);
      const second = await insertRunEvent(event);

      expect(first).toMatchObject({ ok: true, idempotent: false });
      expect(second).toMatchObject({ ok: true, idempotent: true });
      if (first.ok && second.ok) {
        expect(second.eventId).toBe(first.eventId);
      }

      const count = await prisma.runEvent.count({
        where: { runId: run.id, seq: 1 },
      });
      expect(count).toBe(1);
    });

    it("duplicate different payload + same seq is a conflict -> INGEST_SEQ_CONFLICT", async () => {
      const run = await createTestRun();

      await insertRunEvent({
        runId: run.id,
        seq: 1,
        type: "agent_message",
        content: "First",
        payload: { messageId: "msg_1" },
      });

      const conflict = await insertRunEvent({
        runId: run.id,
        seq: 1,
        type: "agent_message",
        content: "Different",
        payload: { messageId: "msg_1" },
      });

      expect(conflict).toMatchObject({
        ok: false,
        code: INGEST_SEQ_CONFLICT,
      });
    });
  },
);

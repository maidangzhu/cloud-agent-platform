import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cap/db";
import { INGEST_SEQ_CONFLICT, insertRunEvent } from "./event-store.js";

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

    // 与 transition-run.integration.test.ts 里"两个并发 transitionRun 只
    // 有一个生效"是同一类问题，但走的是不同的原子化机制：insertRunEvent
    // 内部先查 max seq 再 create，不是一条条件 UPDATE；真正兜底并发写入
    // 同一个 (runId, seq) 的，是 RunEvent 表的 @@unique([runId, seq]) 约束
    // + create 失败后的 P2002 catch 重新判断幂等/冲突（event-store.ts
    // 370-383 行）。这条分支此前从未被真正的并发调用触发过，只有串行调用
    // 两次的测试覆盖了逻辑本身，没覆盖两次几乎同时打到数据库的情况。
    it("concurrent insertRunEvent with same seq + same payload: exactly one row, both calls report ok", async () => {
      const run = await createTestRun();
      const event = {
        runId: run.id,
        seq: 1,
        type: "agent_message" as const,
        content: "Concurrent",
        payload: { messageId: "msg_concurrent" },
      };

      const [first, second] = await Promise.all([
        insertRunEvent(event),
        insertRunEvent(event),
      ]);

      // 两次调用都必须成功（这就是幂等的意义：并发重试不应该让任何一方
      // 看到失败），且恰好一次是真正插入（idempotent:false），另一次命中
      // P2002 catch 后判定为幂等重试（idempotent:true）。
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      const idempotentFlags = [first, second]
        .filter((result): result is Extract<typeof result, { ok: true }> => result.ok)
        .map((result) => result.idempotent);
      expect(idempotentFlags.sort()).toEqual([false, true]);

      const rows = await prisma.runEvent.findMany({
        where: { runId: run.id, seq: 1 },
      });
      expect(rows).toHaveLength(1);
    });

    it("concurrent insertRunEvent with same seq + different payload: exactly one succeeds, the other is INGEST_SEQ_CONFLICT", async () => {
      const run = await createTestRun();

      const [first, second] = await Promise.all([
        insertRunEvent({
          runId: run.id,
          seq: 1,
          type: "agent_message",
          content: "Branch A",
          payload: { messageId: "msg_a" },
        }),
        insertRunEvent({
          runId: run.id,
          seq: 1,
          type: "agent_message",
          content: "Branch B",
          payload: { messageId: "msg_b" },
        }),
      ]);

      const results = [first, second];
      const succeeded = results.filter((result) => result.ok === true);
      const conflicted = results.filter(
        (result) => result.ok === false && result.code === INGEST_SEQ_CONFLICT,
      );
      expect(succeeded).toHaveLength(1);
      expect(conflicted).toHaveLength(1);

      const rows = await prisma.runEvent.findMany({
        where: { runId: run.id, seq: 1 },
      });
      expect(rows).toHaveLength(1);
    });
  },
);

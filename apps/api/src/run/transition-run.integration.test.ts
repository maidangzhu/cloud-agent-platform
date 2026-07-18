import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@cap/db";
import { transitionRun } from "./transition-run.js";
import { finalizeCancelledRunBeforeRunner } from "./orchestrator.js";
import type { RunStatus } from "./transitions.js";

// 连真实 Neon Postgres，不 mock。对应 docs/testing-strategy.md §4.4
// unit 12-14（ADR-0018 原文承认这批测试"需要真实数据库验证并发原子性，
// 无法用 unit test 完全覆盖"，所以放在集成测试里，同 Step 4.2 对 Thread
// 原子拒绝的处理）。用 Step 6.2 提前建的最小 AgentRun 表。
const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)(
  "transitionRun 原子 UPDATE（真实 Neon，ADR-0018，见 Step 6.2）",
  () => {
    const createdRunIds: string[] = [];

    afterAll(async () => {
      if (createdRunIds.length > 0) {
        await prisma.agentRun.deleteMany({
          where: { id: { in: createdRunIds } },
        });
      }
      await prisma.$disconnect();
    });

    // Step 6.3 给 AgentRun 补齐了完整字段（workspaceId/threadId/userId/
    // prompt 变成必填）。这里的 transitionRun 测试不关心这些字段的真实
    // 业务含义，只是满足 not-null 约束，用固定占位值。
    async function createTestRun(status: RunStatus = "created") {
      const run = await prisma.agentRun.create({
        data: {
          id: randomUUID(),
          workspaceId: `it-transition-ws-${Date.now()}`,
          threadId: `it-transition-thread-${Date.now()}`,
          userId: `it-transition-user-${Date.now()}`,
          prompt: "transitionRun test placeholder",
          status,
        },
      });
      createdRunIds.push(run.id);
      return run;
    }

    it("transitionRun applies update when fromStatuses matches current status", async () => {
      const run = await createTestRun("created");

      const result = await transitionRun(run.id, "provisioning_sandbox", [
        "created",
      ]);

      expect(result.applied).toBe(true);
      const updated = await prisma.agentRun.findUnique({
        where: { id: run.id },
      });
      expect(updated?.status).toBe("provisioning_sandbox");
      expect(updated?.completedAt).toBeNull();
    });

    it("sets completedAt when applying a terminal transition", async () => {
      const run = await createTestRun("running");

      const result = await transitionRun(run.id, "completed", ["running"]);

      expect(result.applied).toBe(true);
      const updated = await prisma.agentRun.findUniqueOrThrow({
        where: { id: run.id },
      });
      expect(updated.status).toBe("completed");
      expect(updated.completedAt).toBeTruthy();
    });

    it("finalizes pre-run cancellation with a durable terminal event", async () => {
      const run = await createTestRun("cancel_requested");

      await expect(finalizeCancelledRunBeforeRunner(run.id)).resolves.toBe(true);

      const updated = await prisma.agentRun.findUniqueOrThrow({
        where: { id: run.id },
      });
      expect(updated.status).toBe("cancelled");
      expect(updated.completedAt).toBeTruthy();
      await expect(
        prisma.runEvent.findMany({
          where: { runId: run.id },
          orderBy: { seq: "asc" },
        }),
      ).resolves.toEqual([
        expect.objectContaining({ seq: 1, type: "run_cancelled" }),
      ]);
    });

    it("transitionRun is no-op（0 行）when current status not in fromStatuses", async () => {
      const run = await createTestRun("completed");

      const result = await transitionRun(run.id, "interrupted", ["running"]);

      expect(result.applied).toBe(false);
      const untouched = await prisma.agentRun.findUnique({
        where: { id: run.id },
      });
      // 终态没有被覆盖——status 依然是 completed，updatedAt 也没变化。
      expect(untouched?.status).toBe("completed");
    });

    it("transitionRun does not throw on no-op（并发场景下的另一方失败者路径）", async () => {
      const run = await createTestRun("running");

      await expect(
        transitionRun(run.id, "interrupted", ["created"]),
      ).resolves.toEqual({ applied: false });
    });

    it("concurrent transitionRun calls: only one succeeds, terminal status never overwritten", async () => {
      const run = await createTestRun("running");

      // 模拟 ADR-0018 描述的具体竞态：sweep 判定 heartbeat 过期准备标记
      // interrupted 的同一时刻，sandbox 正好上报 completed。两次调用几乎
      // 同时打到数据库，都以 running 为 fromStatuses。
      const [sweepResult, runnerResult] = await Promise.all([
        transitionRun(run.id, "interrupted", ["running"]),
        transitionRun(run.id, "completed", ["running"]),
      ]);

      // 恰好一次生效，另一次是 no-op（不抛错）。
      const appliedCount = [sweepResult.applied, runnerResult.applied].filter(
        Boolean,
      ).length;
      expect(appliedCount).toBe(1);

      // 最终状态必须是二者之一，且一旦落地就不会被后到的那次覆盖——
      // 因为后到的那次已经不满足 fromStatuses 条件（status 不再是
      // running），影响 0 行。
      const final = await prisma.agentRun.findUnique({
        where: { id: run.id },
      });
      expect(["interrupted", "completed"]).toContain(final?.status);
    });
  },
);

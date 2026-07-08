import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cap/db";
import { transitionRun } from "../run/transition-run.js";
import { sweepStaleRuns } from "./run-sweep.js";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const suiteId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const workspacePrefix = `it-sweep-ws-${suiteId}`;

describe.skipIf(!HAS_DB)(
  "Run sweep core（真实 Neon，ADR-0018，Step 18.1）",
  () => {
    afterAll(async () => {
      const workspaces = await prisma.workspace.findMany({
        where: { id: { startsWith: workspacePrefix } },
        select: { id: true },
      });
      const workspaceIds = workspaces.map((workspace) => workspace.id);
      if (workspaceIds.length > 0) {
        const threads = await prisma.thread.findMany({
          where: { workspaceId: { in: workspaceIds } },
          select: { id: true },
        });
        const threadIds = threads.map((thread) => thread.id);
        const runs = await prisma.agentRun.findMany({
          where: { threadId: { in: threadIds } },
          select: { id: true },
        });
        const runIds = runs.map((run) => run.id);
        if (runIds.length > 0) {
          await prisma.workspaceSandboxInstance.deleteMany({
            where: { currentRunId: { in: runIds } },
          });
          await prisma.runEvent.deleteMany({ where: { runId: { in: runIds } } });
          await prisma.runToolCall.deleteMany({
            where: { runId: { in: runIds } },
          });
          await prisma.agentRun.deleteMany({ where: { id: { in: runIds } } });
        }
        await prisma.workspaceSandboxInstance.deleteMany({
          where: { workspaceId: { in: workspaceIds } },
        });
        await prisma.thread.deleteMany({ where: { id: { in: threadIds } } });
        await prisma.workspace.deleteMany({
          where: { id: { in: workspaceIds } },
        });
      }
      await prisma.user.deleteMany({
        where: { id: { startsWith: `it-sweep-user-${suiteId}` } },
      });
      await prisma.$disconnect();
    });

    it("marks stale running run as interrupted and releases sandbox claim", async () => {
      const now = new Date("2026-03-01T00:00:00.000Z");
      const graph = await createGraph("stale-running");
      const run = await createRun(graph, {
        label: "stale-running",
        status: "running",
        maxDurationSec: 10,
        lastHeartbeatAt: new Date(now.getTime() - 11_000),
      });
      const instance = await createSandboxInstance(graph.workspaceId, run.id);

      const result = await sweepStaleRuns({ now, runIds: [run.id] });

      expect(result.transitioned).toContainEqual({
        runId: run.id,
        fromStatus: "running",
        toStatus: "interrupted",
        applied: true,
      });
      const updated = await prisma.agentRun.findUniqueOrThrow({
        where: { id: run.id },
      });
      expect(updated.status).toBe("interrupted");
      const released = await prisma.workspaceSandboxInstance.findUniqueOrThrow({
        where: { id: instance.id },
      });
      expect(released.currentRunId).toBeNull();
      expect(released.status).toBe("warm");
    });

    it("marks stale provisioning_sandbox run as timeout", async () => {
      const now = new Date("2026-03-01T00:00:00.000Z");
      const graph = await createGraph("stale-provisioning");
      const run = await createRun(graph, {
        label: "stale-provisioning",
        status: "provisioning_sandbox",
        createdAt: new Date(now.getTime() - 301_000),
      });

      const result = await sweepStaleRuns({
        now,
        provisioningTimeoutMs: 300_000,
        runIds: [run.id],
      });

      expect(result.transitioned).toContainEqual({
        runId: run.id,
        fromStatus: "provisioning_sandbox",
        toStatus: "timeout",
        applied: true,
      });
      const updated = await prisma.agentRun.findUniqueOrThrow({
        where: { id: run.id },
      });
      expect(updated.status).toBe("timeout");
    });

    it("marks stale created run as failed", async () => {
      const now = new Date("2026-03-01T00:00:00.000Z");
      const graph = await createGraph("stale-created");
      const run = await createRun(graph, {
        label: "stale-created",
        status: "created",
        createdAt: new Date(now.getTime() - 301_000),
      });

      const result = await sweepStaleRuns({
        now,
        createdTimeoutMs: 300_000,
        runIds: [run.id],
      });

      expect(result.transitioned).toContainEqual({
        runId: run.id,
        fromStatus: "created",
        toStatus: "failed",
        applied: true,
      });
      await expectStatus(run.id, "failed");
    });

    it("marks stale cancel_requested run as cancelled", async () => {
      const now = new Date("2026-03-01T00:00:00.000Z");
      const graph = await createGraph("stale-cancel");
      const run = await createRun(graph, {
        label: "stale-cancel",
        status: "cancel_requested",
      });
      await prisma.agentRun.update({
        where: { id: run.id },
        data: { updatedAt: new Date(now.getTime() - 61_000) },
      });

      const result = await sweepStaleRuns({
        now,
        cancelTimeoutMs: 60_000,
        runIds: [run.id],
      });

      expect(result.transitioned).toContainEqual({
        runId: run.id,
        fromStatus: "cancel_requested",
        toStatus: "cancelled",
        applied: true,
      });
      const updated = await prisma.agentRun.findUniqueOrThrow({
        where: { id: run.id },
      });
      expect(updated.status).toBe("cancelled");
    });

    it("does not sweep fresh running or waiting_for_input runs within threshold", async () => {
      const now = new Date("2026-03-01T00:00:00.000Z");
      const graph = await createGraph("fresh");
      const fresh = await createRun(graph, {
        label: "fresh-running",
        status: "running",
        maxDurationSec: 60,
        lastHeartbeatAt: new Date(now.getTime() - 1_000),
      });
      const waiting = await createRun(graph, {
        label: "waiting",
        status: "waiting_for_input",
        updatedAt: new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000),
      });

      const result = await sweepStaleRuns({ now, runIds: [fresh.id, waiting.id] });

      expect(result.transitioned.some((item) => item.runId === fresh.id)).toBe(
        false,
      );
      expect(result.transitioned.some((item) => item.runId === waiting.id)).toBe(
        false,
      );
      await expectStatus(fresh.id, "running");
      await expectStatus(waiting.id, "waiting_for_input");
    });

    it("marks waiting_for_input run past threshold as interrupted", async () => {
      const now = new Date("2026-03-01T00:00:00.000Z");
      const graph = await createGraph("waiting-threshold");
      const waiting = await createRun(graph, {
        label: "waiting-threshold",
        status: "waiting_for_input",
        updatedAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000),
      });

      const result = await sweepStaleRuns({ now, runIds: [waiting.id] });

      expect(result.transitioned).toContainEqual({
        runId: waiting.id,
        fromStatus: "waiting_for_input",
        toStatus: "interrupted",
        applied: true,
      });
      await expectStatus(waiting.id, "interrupted");
    });

    it("concurrent sweep and runner completion race has one winner and never overwrites terminal status", async () => {
      const now = new Date("2026-03-01T00:00:00.000Z");
      const graph = await createGraph("race");
      const run = await createRun(graph, {
        label: "race",
        status: "running",
        maxDurationSec: 10,
        lastHeartbeatAt: new Date(now.getTime() - 11_000),
      });

      const [sweepResult, runnerResult] = await Promise.all([
        sweepStaleRuns({ now, runIds: [run.id] }),
        transitionRun(run.id, "completed", ["running"]),
      ]);

      const sweepRunResult = sweepResult.transitioned.find(
        (item) => item.runId === run.id,
      );
      const appliedCount = [
        sweepRunResult?.applied === true,
        runnerResult.applied,
      ].filter(Boolean).length;
      expect(appliedCount).toBe(1);

      const final = await prisma.agentRun.findUniqueOrThrow({
        where: { id: run.id },
      });
      expect(["interrupted", "completed"]).toContain(final.status);
    });
  },
);

type TestGraph = {
  userId: string;
  workspaceId: string;
  threadId: string;
};

async function createGraph(label: string): Promise<TestGraph> {
  const userId = `it-sweep-user-${suiteId}-${label}-${randomUUID().slice(0, 8)}`;
  const workspaceId = `${workspacePrefix}-${label}-${randomUUID().slice(0, 8)}`;
  const threadId = `it-sweep-thread-${suiteId}-${label}-${randomUUID().slice(0, 8)}`;

  await prisma.user.create({
    data: {
      id: userId,
      email: `${userId}@example.com`,
      name: "Sweep Test User",
    },
  });
  await prisma.workspace.create({
    data: {
      id: workspaceId,
      ownerUserId: userId,
      title: `IT-SweepWs-${label}`,
    },
  });
  await prisma.thread.create({
    data: {
      id: threadId,
      workspaceId,
      title: `IT-SweepThread-${label}`,
    },
  });

  return { userId, workspaceId, threadId };
}

async function createRun(
  graph: TestGraph,
  params: {
    label: string;
    status:
      | "created"
      | "running"
      | "provisioning_sandbox"
      | "cancel_requested"
      | "waiting_for_input";
    maxDurationSec?: number;
    createdAt?: Date;
    lastHeartbeatAt?: Date;
    updatedAt?: Date;
  },
) {
  return prisma.agentRun.create({
    data: {
      id: `it-sweep-run-${suiteId}-${params.label}-${randomUUID().slice(0, 8)}`,
      workspaceId: graph.workspaceId,
      threadId: graph.threadId,
      userId: graph.userId,
      prompt: `sweep ${params.label}`,
      status: params.status,
      maxDurationSec: params.maxDurationSec ?? 60,
      ...(params.createdAt ? { createdAt: params.createdAt } : {}),
      ...(params.lastHeartbeatAt
        ? { lastHeartbeatAt: params.lastHeartbeatAt }
        : {}),
      ...(params.updatedAt ? { updatedAt: params.updatedAt } : {}),
    },
  });
}

async function createSandboxInstance(workspaceId: string, runId: string) {
  return prisma.workspaceSandboxInstance.create({
    data: {
      id: `it-sweep-sandbox-${suiteId}-${randomUUID().slice(0, 8)}`,
      workspaceId,
      provider: "vercel",
      sandboxName: `it-sweep-sandbox-${suiteId}-${randomUUID().slice(0, 8)}`,
      status: "ready",
      currentRunId: runId,
    },
  });
}

async function expectStatus(runId: string, status: string) {
  const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });
  expect(run.status).toBe(status);
}

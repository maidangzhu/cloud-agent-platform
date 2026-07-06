import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cap/db";
import { createApp } from "../app";
import { issueRunToken } from "../run/run-token";
import { resolveVercelCredentials } from "../../../../src/server/sandbox/vercel-credentials";
import {
  getOrCreateWorkspaceSandbox,
  runScriptedIngestRunnerInSandbox,
  sandboxNameForWorkspace,
  sweepOrphanWorkspaceSandboxes,
  type WorkspaceSandboxClaim,
} from "./workspace-sandbox";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const HAS_SECRET = Boolean(process.env.RUN_TOKEN_SECRET ?? process.env.BETTER_AUTH_SECRET);
const HAS_VERCEL = Boolean(resolveVercelCredentials());
const PUBLIC_INGEST_BASE_URL =
  process.env.CAP_API_BASE_URL ??
  process.env.INGEST_BASE_URL ??
  process.env.API_BASE_URL ??
  "";

const suiteId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const workspacePrefix = `it-ws-sbx-${suiteId}`;
const userEmailDomain = `it-sbx-${suiteId}.example.com`;
const app = createApp();
const trackedSandboxes = new Map<string, WorkspaceSandboxClaim["sandbox"]>();

type TestGraph = {
  userId: string;
  workspaceId: string;
  threadId: string;
  runId: string;
};

describe.skipIf(!HAS_DB || !HAS_SECRET)(
  "Workspace sandbox DB lifecycle（真实 Neon，见 Step 9.2）",
  () => {
    afterAll(cleanup);

    it("run entering waiting_for_input releases WorkspaceSandboxInstance to warm", async () => {
      const graph = await createGraph("waiting-release");
      const instance = await prisma.workspaceSandboxInstance.create({
        data: {
          id: randomUUID(),
          workspaceId: graph.workspaceId,
          provider: "vercel",
          sandboxName: sandboxNameForWorkspace(graph.workspaceId),
          status: "ready",
          currentRunId: graph.runId,
          lastUsedAt: new Date(),
        },
      });

      const res = await app.request("/api/ingest/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenFor(graph)}`,
        },
        body: JSON.stringify({
          seq: 1,
          type: "run_waiting_for_input",
          payload: { question: "Need input?" },
        }),
      });

      expect(res.status).toBe(200);
      const run = await prisma.agentRun.findUniqueOrThrow({
        where: { id: graph.runId },
      });
      expect(run.status).toBe("waiting_for_input");

      const released = await prisma.workspaceSandboxInstance.findUniqueOrThrow({
        where: { id: instance.id },
      });
      expect(released.currentRunId).toBeNull();
      expect(released.status).toBe("warm");
      expect(released.lastUsedAt).toBeInstanceOf(Date);
    });

    it("orphan WorkspaceSandboxInstance is swept and marked stopped", async () => {
      const graph = await createGraph("orphan-sweep");
      const oldLastUsedAt = new Date(Date.now() - 10 * 60_000);
      const instance = await prisma.workspaceSandboxInstance.create({
        data: {
          id: randomUUID(),
          workspaceId: graph.workspaceId,
          provider: "vercel",
          sandboxName: sandboxNameForWorkspace(graph.workspaceId),
          status: "warm",
          currentRunId: null,
          lastUsedAt: oldLastUsedAt,
        },
      });

      const swept = await sweepOrphanWorkspaceSandboxes({
        olderThan: new Date(Date.now() - 60_000),
        stopProvider: false,
      });

      expect(swept).toBeGreaterThanOrEqual(1);
      const stopped = await prisma.workspaceSandboxInstance.findUniqueOrThrow({
        where: { id: instance.id },
      });
      expect(stopped.status).toBe("stopped");
      expect(stopped.currentRunId).toBeNull();
    });
  },
);

describe.skipIf(!HAS_DB || !HAS_SECRET || !HAS_VERCEL)(
  "Workspace sandbox claim + Vercel microVM（真实 Neon + 真沙箱，见 Step 9.2）",
  () => {
    afterAll(cleanup);

    it("creates sandbox when no warm/ready instance exists, then resumes stopped and warm states", async () => {
      const graph = await createGraph("create-resume");

      const first = await track(
        await getOrCreateWorkspaceSandbox({
          workspaceId: graph.workspaceId,
          runId: graph.runId,
          timeoutMs: 60_000,
        }),
      );
      expect(first.reused).toBe(false);
      expect(first.instance.workspaceId).toBe(graph.workspaceId);
      expect(first.instance.currentRunId).toBe(graph.runId);
      expect(first.instance.status).toBe("ready");
      expect(first.instance.sandboxName).toBe(sandboxNameForWorkspace(graph.workspaceId));

      await prisma.workspaceSandboxInstance.update({
        where: { id: first.instance.id },
        data: { status: "stopped", currentRunId: null },
      });
      const stoppedRun = await createRun(graph, "stopped-resume");
      const resumedFromStopped = await track(
        await getOrCreateWorkspaceSandbox({
          workspaceId: graph.workspaceId,
          runId: stoppedRun.id,
          timeoutMs: 60_000,
        }),
      );
      expect(resumedFromStopped.reused).toBe(true);
      expect(resumedFromStopped.instance.id).toBe(first.instance.id);
      expect(resumedFromStopped.instance.sandboxName).toBe(first.instance.sandboxName);
      expect(resumedFromStopped.instance.currentRunId).toBe(stoppedRun.id);
      expect(resumedFromStopped.instance.status).toBe("ready");

      await prisma.workspaceSandboxInstance.update({
        where: { id: first.instance.id },
        data: { status: "warm", currentRunId: null },
      });
      const warmRun = await createRun(graph, "warm-resume");
      const resumedFromWarm = await track(
        await getOrCreateWorkspaceSandbox({
          workspaceId: graph.workspaceId,
          runId: warmRun.id,
          timeoutMs: 60_000,
        }),
      );
      expect(resumedFromWarm.reused).toBe(true);
      expect(resumedFromWarm.instance.id).toBe(first.instance.id);
      expect(resumedFromWarm.instance.sandboxName).toBe(first.instance.sandboxName);
      expect(resumedFromWarm.instance.currentRunId).toBe(warmRun.id);
      expect(resumedFromWarm.instance.status).toBe("ready");
    });

    it("concurrent getOrCreate only lets one run claim the warm instance", async () => {
      const graph = await createGraph("concurrent-claim");
      const first = await track(
        await getOrCreateWorkspaceSandbox({
          workspaceId: graph.workspaceId,
          runId: graph.runId,
          timeoutMs: 60_000,
        }),
      );
      await prisma.workspaceSandboxInstance.update({
        where: { id: first.instance.id },
        data: { status: "warm", currentRunId: null },
      });

      const runA = await createRun(graph, "concurrent-a");
      const runB = await createRun(graph, "concurrent-b");
      const [claimA, claimB] = await Promise.all([
        getOrCreateWorkspaceSandbox({
          workspaceId: graph.workspaceId,
          runId: runA.id,
          timeoutMs: 60_000,
        }),
        getOrCreateWorkspaceSandbox({
          workspaceId: graph.workspaceId,
          runId: runB.id,
          timeoutMs: 60_000,
        }),
      ]);
      await track(claimA);
      await track(claimB);

      const claimedExisting = [claimA, claimB].filter(
        (claim) => claim.instance.id === first.instance.id,
      );
      const createdNew = [claimA, claimB].filter(
        (claim) => claim.instance.id !== first.instance.id,
      );

      expect(claimedExisting).toHaveLength(1);
      expect(createdNew).toHaveLength(1);
      expect(claimedExisting[0]?.reused).toBe(true);
      expect(createdNew[0]?.reused).toBe(false);
      expect(new Set([claimA.instance.currentRunId, claimB.instance.currentRunId])).toEqual(
        new Set([runA.id, runB.id]),
      );
      expect(claimA.instance.sandboxName).not.toBe(claimB.instance.sandboxName);
    });

    it("next run on the same workspace reuses the warm instance released by waiting_for_input", async () => {
      const graph = await createGraph("waiting-then-reuse");
      const first = await track(
        await getOrCreateWorkspaceSandbox({
          workspaceId: graph.workspaceId,
          runId: graph.runId,
          timeoutMs: 60_000,
        }),
      );

      const res = await app.request("/api/ingest/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenFor(graph)}`,
        },
        body: JSON.stringify({
          seq: 1,
          type: "run_waiting_for_input",
          payload: { question: "Continue?" },
        }),
      });
      expect(res.status).toBe(200);

      const secondRun = await createRun(graph, "after-waiting");
      const second = await track(
        await getOrCreateWorkspaceSandbox({
          workspaceId: graph.workspaceId,
          runId: secondRun.id,
          timeoutMs: 60_000,
        }),
      );

      expect(second.reused).toBe(true);
      expect(second.instance.id).toBe(first.instance.id);
      expect(second.instance.sandboxName).toBe(first.instance.sandboxName);
      expect(second.instance.currentRunId).toBe(secondRun.id);
    });

    it.skipIf(!PUBLIC_INGEST_BASE_URL)(
      "runs scripted ingest runner inside Vercel Sandbox and observes it only through ingest",
      async () => {
        const graph = await createGraph("vercel-runner");
        const claim = await track(
          await getOrCreateWorkspaceSandbox({
            workspaceId: graph.workspaceId,
            runId: graph.runId,
            timeoutMs: 60_000,
          }),
        );

        const result = await runScriptedIngestRunnerInSandbox({
          sandbox: claim.sandbox,
          ingestBaseUrl: PUBLIC_INGEST_BASE_URL,
          runToken: tokenFor(graph),
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain('"insideSandbox":true');
        expect(result.stdout).toContain('"forbiddenEnvPresent":false');

        const run = await prisma.agentRun.findUniqueOrThrow({
          where: { id: graph.runId },
        });
        expect(run.status).toBe("completed");

        const events = await prisma.runEvent.findMany({
          where: { runId: graph.runId },
          orderBy: { seq: "asc" },
        });
        expect(events.map((event) => event.type)).toEqual([
          "run_created",
          "agent_started",
          "run_completed",
        ]);

        const toolCall = await prisma.runToolCall.findFirstOrThrow({
          where: { runId: graph.runId },
        });
        expect(toolCall.status).toBe("completed");
      },
    );
  },
);

async function createGraph(label: string): Promise<TestGraph> {
  const userId = `it-user-${suiteId}-${label}-${randomUUID().slice(0, 8)}`;
  const workspaceId = `${workspacePrefix}-${label}`;
  const threadId = `it-thread-${suiteId}-${label}-${randomUUID().slice(0, 8)}`;
  const runId = `it-run-${suiteId}-${label}-${randomUUID().slice(0, 8)}`;

  await prisma.user.create({
    data: {
      id: userId,
      email: `${label}-${randomUUID().slice(0, 8)}@${userEmailDomain}`,
      name: "Workspace Sandbox Test User",
    },
  });
  await prisma.workspace.create({
    data: {
      id: workspaceId,
      ownerUserId: userId,
      title: `IT-WorkspaceSandbox-${label}`,
    },
  });
  await prisma.thread.create({
    data: {
      id: threadId,
      workspaceId,
      title: `IT-WorkspaceSandboxThread-${label}`,
    },
  });
  await prisma.agentRun.create({
    data: {
      id: runId,
      workspaceId,
      threadId,
      userId,
      prompt: `sandbox ${label}`,
      status: "running",
    },
  });

  return { userId, workspaceId, threadId, runId };
}

async function createRun(
  graph: Pick<TestGraph, "workspaceId" | "threadId" | "userId">,
  label: string,
) {
  return prisma.agentRun.create({
    data: {
      id: `it-run-${suiteId}-${label}-${randomUUID().slice(0, 8)}`,
      workspaceId: graph.workspaceId,
      threadId: graph.threadId,
      userId: graph.userId,
      prompt: `sandbox ${label}`,
      status: "running",
    },
  });
}

function tokenFor(graph: TestGraph): string {
  return issueRunToken({
    userId: graph.userId,
    workspaceId: graph.workspaceId,
    threadId: graph.threadId,
    runId: graph.runId,
  });
}

async function track(claim: WorkspaceSandboxClaim): Promise<WorkspaceSandboxClaim> {
  trackedSandboxes.set(claim.instance.sandboxName, claim.sandbox);
  return claim;
}

async function cleanup(): Promise<void> {
  for (const sandbox of trackedSandboxes.values()) {
    await sandbox.stop().catch(() => undefined);
  }
  trackedSandboxes.clear();

  const workspaces = await prisma.workspace.findMany({
    where: { id: { startsWith: workspacePrefix } },
    select: { id: true },
  });
  const workspaceIds = workspaces.map((workspace) => workspace.id);
  if (workspaceIds.length > 0) {
    const runs = await prisma.agentRun.findMany({
      where: { workspaceId: { in: workspaceIds } },
      select: { id: true },
    });
    const runIds = runs.map((run) => run.id);
    if (runIds.length > 0) {
      await prisma.runToolCall.deleteMany({ where: { runId: { in: runIds } } });
      await prisma.runEvent.deleteMany({ where: { runId: { in: runIds } } });
      await prisma.agentRun.deleteMany({ where: { id: { in: runIds } } });
    }
    await prisma.workspaceSandboxInstance.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });
    await prisma.thread.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
  }
  await prisma.user.deleteMany({
    where: { email: { endsWith: userEmailDomain } },
  });
  await prisma.$disconnect();
}

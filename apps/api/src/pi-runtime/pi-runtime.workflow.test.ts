import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cap/db";
import { buildPiRuntimeStartConfig } from "./config.js";
import { issueRunToken } from "../run/run-token.js";
import { resolveVercelCredentials } from "../sandbox/vercel-credentials.js";
import {
  getOrCreateWorkspaceSandbox,
  releaseWorkspaceSandboxForRun,
  runPiRuntimeInSandbox,
  type WorkspaceSandboxClaim,
} from "../sandbox/workspace-sandbox.js";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const HAS_SECRET = Boolean(process.env.BETTER_AUTH_SECRET);
const HAS_VERCEL = Boolean(resolveVercelCredentials());
const PUBLIC_API_BASE_URL =
  process.env.PUBLIC_AGENT_LOOP_BASE_URL ??
  process.env.CAP_API_BASE_URL ??
  process.env.INGEST_BASE_URL ??
  process.env.API_BASE_URL ??
  process.env.PUBLIC_API_BASE_URL ??
  process.env.PUBLIC_INGEST_BASE_URL ??
  publicUrlOrUndefined(process.env.BETTER_AUTH_URL);

describe.skipIf(!HAS_DB || !HAS_SECRET || !HAS_VERCEL || !PUBLIC_API_BASE_URL)(
  "Pi runtime Vercel Sandbox smoke",
  () => {
    const suiteId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const created = {
      userIds: [] as string[],
      workspaceIds: [] as string[],
      threadIds: [] as string[],
      runIds: [] as string[],
      sandboxes: [] as WorkspaceSandboxClaim["sandbox"][],
    };

    afterAll(async () => {
      for (const sandbox of created.sandboxes) {
        await sandbox.stop().catch(() => undefined);
      }
      for (const runId of created.runIds) {
        await releaseWorkspaceSandboxForRun(runId, "stopped").catch(() => undefined);
      }
      await prisma.runEvent.deleteMany({
        where: { runId: { in: created.runIds } },
      });
      await prisma.runToolCall.deleteMany({
        where: { runId: { in: created.runIds } },
      });
      await prisma.agentRun.deleteMany({
        where: { id: { in: created.runIds } },
      });
      await prisma.thread.deleteMany({
        where: { id: { in: created.threadIds } },
      });
      await prisma.workspace.deleteMany({
        where: { id: { in: created.workspaceIds } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: created.userIds } },
      });
      await prisma.$disconnect();
    });

    it(
      "installs Pi packages and calls hosted Control Plane from inside real sandbox",
      async () => {
        const graph = await createGraph(suiteId, created);
        const runToken = issueRunToken({
          userId: graph.userId,
          workspaceId: graph.workspaceId,
          threadId: graph.threadId,
          runId: graph.runId,
          ttlSeconds: 900,
        });
        const claim = await getOrCreateWorkspaceSandbox({
          workspaceId: graph.workspaceId,
          runId: graph.runId,
          timeoutMs: 60_000,
        });
        created.sandboxes.push(claim.sandbox);

        const result = await runPiRuntimeInSandbox({
          sandbox: claim.sandbox,
          config: buildPiRuntimeStartConfig({
            apiBaseUrl: PUBLIC_API_BASE_URL!,
            runToken,
            run: {
              id: graph.runId,
              workspaceId: graph.workspaceId,
              threadId: graph.threadId,
              userId: graph.userId,
              prompt: "pi runtime hosted callback smoke",
              maxDurationSec: 180,
            },
          }),
          installTimeoutMs: 240_000,
          execTimeoutMs: 120_000,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        const output = parseLastJsonLine(result.stdout);
        expect(output).toMatchObject({
          piRuntimeStarted: true,
          runId: graph.runId,
          apiBaseUrl: PUBLIC_API_BASE_URL,
          forbiddenEnvPresent: false,
        });
        expect(output.messageCount).toBeGreaterThanOrEqual(2);

        const updated = await prisma.agentRun.findUniqueOrThrow({
          where: { id: graph.runId },
        });
        expect(updated.lastHeartbeatAt).toBeTruthy();
        expect(updated.phase).toBe("finalize");
      },
      300_000,
    );
  },
);

function publicUrlOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
      ? undefined
      : value;
  } catch {
    return undefined;
  }
}

async function createGraph(
  suiteId: string,
  created: {
    userIds: string[];
    workspaceIds: string[];
    threadIds: string[];
    runIds: string[];
  },
): Promise<{
  userId: string;
  workspaceId: string;
  threadId: string;
  runId: string;
}> {
  const userId = `it-pi-user-${suiteId}`;
  const workspaceId = `it-pi-workspace-${suiteId}`;
  const threadId = `it-pi-thread-${suiteId}`;
  const runId = `it-pi-run-${suiteId}`;
  created.userIds.push(userId);
  created.workspaceIds.push(workspaceId);
  created.threadIds.push(threadId);
  created.runIds.push(runId);

  await prisma.user.create({
    data: {
      id: userId,
      email: `it-pi-runtime-${suiteId}@example.com`,
      name: "Pi Runtime Test User",
    },
  });
  await prisma.workspace.create({
    data: {
      id: workspaceId,
      ownerUserId: userId,
      title: `IT-PiRuntimeWs-${suiteId}`,
    },
  });
  await prisma.thread.create({
    data: {
      id: threadId,
      workspaceId,
      title: "IT-PiRuntimeThread",
    },
  });
  await prisma.agentRun.create({
    data: {
      id: runId,
      workspaceId,
      threadId,
      userId,
      prompt: "pi runtime hosted callback smoke",
      status: "running",
      maxDurationSec: 180,
    },
  });

  return { userId, workspaceId, threadId, runId };
}

function parseLastJsonLine(stdout: string): Record<string, unknown> {
  const line = stdout
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.startsWith("{") && value.endsWith("}"))
    .at(-1);
  if (!line) throw new Error(`no JSON line found in stdout: ${stdout}`);
  return JSON.parse(line) as Record<string, unknown>;
}

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cap/db";
import { resolveVercelCredentials } from "../../../../src/server/sandbox/vercel-credentials";
import { createApp } from "../app";
import {
  deleteRunStream,
  disconnectRedis,
  readRunStream,
} from "../redis/streams";
import { issueRunToken } from "../run/run-token";
import {
  getOrCreateWorkspaceSandbox,
  installAgentLoopScriptInSandbox,
  runAgentLoopScriptInSandbox,
  type WorkspaceSandboxClaim,
} from "../sandbox/workspace-sandbox";
import { runAgentLoop } from "./agent-loop";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const HAS_SECRET = Boolean(process.env.BETTER_AUTH_SECRET);
const HAS_REDIS = Boolean(process.env.REDIS_URL);
const HAS_VERCEL = Boolean(resolveVercelCredentials());
const PUBLIC_API_BASE_URL =
  process.env.PUBLIC_AGENT_LOOP_BASE_URL ??
  process.env.CAP_API_BASE_URL ??
  process.env.INGEST_BASE_URL ??
  process.env.API_BASE_URL ??
  process.env.PUBLIC_API_BASE_URL ??
  process.env.PUBLIC_INGEST_BASE_URL;

async function signUpAndGetCookie(
  app: ReturnType<typeof createApp>,
  email: string,
): Promise<string> {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "integration-test-password-789",
      name: "Agent Loop Test User",
    }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("sign-up did not set a session cookie");
  return cookie;
}

describe.skipIf(!HAS_DB || !HAS_SECRET)(
  "Agent loop Step 16.1/16.2（真实 Neon + fake LLM proxy + ingest/Redis）",
  () => {
    const app = createApp();
    const suiteId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const userEmail = `it-agent-loop-${suiteId}@example.com`;
    const trackedSandboxes: WorkspaceSandboxClaim["sandbox"][] = [];
    let cookie = "";
    let workspaceId = "";
    let threadId = "";
    const runIds: string[] = [];

    afterAll(async () => {
      for (const sandbox of trackedSandboxes) {
        await sandbox.stop().catch(() => undefined);
      }
      for (const runId of runIds) {
        await deleteRunStream(runId).catch(() => undefined);
      }

      const workspaces = await prisma.workspace.findMany({
        where: { title: { startsWith: "IT-AgentLoopWs-" } },
      });
      const workspaceIds = workspaces.map((w) => w.id);
      if (workspaceIds.length > 0) {
        const threads = await prisma.thread.findMany({
          where: { workspaceId: { in: workspaceIds } },
        });
        const threadIds = threads.map((t) => t.id);
        const runs = await prisma.agentRun.findMany({
          where: { threadId: { in: threadIds } },
        });
        const runIds = runs.map((r) => r.id);
        if (runIds.length > 0) {
          await prisma.lLMUsageRecord.deleteMany({
            where: { runId: { in: runIds } },
          });
          await prisma.source.deleteMany({ where: { runId: { in: runIds } } });
          await prisma.workspaceArtifactVersion.deleteMany({
            where: { runId: { in: runIds } },
          });
          await prisma.workspaceArtifact.deleteMany({
            where: { runId: { in: runIds } },
          });
          await prisma.workspaceFile.deleteMany({
            where: { latestRunId: { in: runIds } },
          });
          await prisma.runToolCall.deleteMany({
            where: { runId: { in: runIds } },
          });
          await prisma.runEvent.deleteMany({
            where: { runId: { in: runIds } },
          });
          await prisma.agentRun.deleteMany({
            where: { id: { in: runIds } },
          });
        }
        await prisma.workspaceSandboxInstance.deleteMany({
          where: { workspaceId: { in: workspaceIds } },
        });
        await prisma.thread.deleteMany({ where: { id: { in: threadIds } } });
        await prisma.workspace.deleteMany({
          where: { id: { in: workspaceIds } },
        });
      }
      await prisma.user.deleteMany({ where: { email: userEmail } });
      await disconnectRedis();
      await prisma.$disconnect();
    });

    async function createRun(prompt: string) {
      const res = await app.request(`/api/threads/${threadId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ prompt }),
      });
      expect(res.status).toBe(200);
      const runId = (await res.json()).data.run.id as string;
      runIds.push(runId);
      return prisma.agentRun.update({
        where: { id: runId },
        data: { status: "running" },
      });
    }

    function tokenFor(run: {
      id: string;
      userId: string;
      workspaceId: string;
      threadId: string;
    }) {
      return issueRunToken({
        userId: run.userId,
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        runId: run.id,
      });
    }

    it("准备：注册用户，建 workspace + thread", async () => {
      cookie = await signUpAndGetCookie(app, userEmail);

      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ title: `IT-AgentLoopWs-${suiteId}` }),
      });
      workspaceId = (await wsRes.json()).data.workspace.id;

      const threadRes = await app.request(
        `/api/workspaces/${workspaceId}/threads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ title: "IT-AgentLoopThread" }),
        },
      );
      threadId = (await threadRes.json()).data.thread.id;

      expect(workspaceId).toBeTruthy();
      expect(threadId).toBeTruthy();
    });

    it("runs non-streaming agent loop with fake LLM tool calls", async () => {
      const run = await createRun("produce a short architecture report");

      const result = await runAgentLoop({
        runId: run.id,
        prompt: run.prompt,
        runToken: tokenFor(run),
        request: (path, init) => Promise.resolve(app.request(path, init)),
      });

      expect(result.completed).toBe(true);
      expect(result.llmToolCalls).toBe(2);
      expect(result.calls.map((call) => call.path)).toContain("/api/llm-proxy");

      const updated = await prisma.agentRun.findUniqueOrThrow({
        where: { id: run.id },
      });
      expect(updated.status).toBe("completed");

      const file = await prisma.workspaceFile.findFirst({
        where: { workspaceId, path: "reports/agent-loop-report.md" },
      });
      expect(file?.content).toContain("# Agent Loop Report");

      const artifact = await prisma.workspaceArtifact.findFirst({
        where: { runId: run.id, title: "Agent Loop Report" },
      });
      expect(artifact).toMatchObject({
        kind: "text",
        path: "reports/agent-loop-report.md",
        version: 1,
      });

      const toolCalls = await prisma.runToolCall.findMany({
        where: { runId: run.id },
        orderBy: { name: "asc" },
      });
      expect(toolCalls.map((tool) => `${tool.name}:${tool.status}`).sort()).toEqual([
        "create_artifact:completed",
        "write_file:completed",
      ]);

      const eventTypes = (
        await prisma.runEvent.findMany({
          where: { runId: run.id },
          orderBy: { seq: "asc" },
        })
      ).map((event) => event.type);
      expect(eventTypes).toEqual([
        "run_created",
        "runner_started",
        "agent_started",
        "agent_message",
        "file_written",
        "artifact_created",
        "run_completed",
      ]);
    });

    it.skipIf(!HAS_REDIS)("streams LLM chunks to Redis before semantic events are persisted", async () => {
      const run = await createRun("stream a short architecture report");
      const persistedDuringChunks: number[] = [];

      const result = await runAgentLoop({
        runId: run.id,
        prompt: run.prompt,
        runToken: tokenFor(run),
        stream: true,
        request: async (path, init) => {
          const response = await app.request(path, init);
          if (path === "/api/ingest/stream-chunk") {
            const persisted = await prisma.runEvent.count({
              where: {
                runId: run.id,
                type: { in: ["agent_thinking", "agent_message"] },
              },
            });
            persistedDuringChunks.push(persisted);
          }
          return response;
        },
      });

      expect(result.completed).toBe(true);
      expect(persistedDuringChunks).toEqual([0, 0]);

      const streamEntries = await readRunStream({
        runId: run.id,
        cursor: "0",
        blockMs: 100,
      });
      expect(streamEntries.map((entry) => entry.streamType)).toEqual([
        "thinking",
        "content",
      ]);
      expect(streamEntries[0]?.chunk).toBe(
        "fake reasoning for: stream a short architecture report",
      );
      expect(streamEntries[1]?.chunk).toBe(
        "fake response for: stream a short architecture report",
      );

      const semanticEvents = await prisma.runEvent.findMany({
        where: {
          runId: run.id,
          type: { in: ["agent_thinking", "agent_message"] },
        },
        orderBy: { seq: "asc" },
      });
      expect(semanticEvents.map((event) => event.type)).toEqual([
        "agent_thinking",
        "agent_message",
      ]);
      expect(semanticEvents[0]?.content).toBe(streamEntries[0]?.chunk);
      expect(semanticEvents[1]?.content).toBe(streamEntries[1]?.chunk);
    });

    it.skipIf(!HAS_VERCEL || !PUBLIC_API_BASE_URL)(
      "runs the same agent loop script inside real Vercel Sandbox",
      async () => {
        const run = await createRun("produce a sandbox architecture report");
        const claim = await getOrCreateWorkspaceSandbox({
          workspaceId,
          runId: run.id,
          timeoutMs: 60_000,
        });
        trackedSandboxes.push(claim.sandbox);

        const result = await runAgentLoopScriptInSandbox({
          sandbox: claim.sandbox,
          apiBaseUrl: PUBLIC_API_BASE_URL!,
          runToken: tokenFor(run),
          runId: run.id,
          prompt: run.prompt,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain('"insideSandbox":true');
        expect(result.stdout).toContain('"forbiddenEnvPresent":false');
        expect(result.stdout).toContain('"llmToolCalls":2');

        const artifact = await prisma.workspaceArtifact.findFirst({
          where: { runId: run.id, title: "Agent Loop Report" },
        });
        expect(artifact?.version).toBe(1);
        const updated = await prisma.agentRun.findUniqueOrThrow({
          where: { id: run.id },
        });
        expect(updated.status).toBe("completed");
      },
      180_000,
    );

    it.skipIf(!HAS_VERCEL)(
      "writes agent loop runtime files into real Vercel Sandbox and starts Node there",
      async () => {
        const run = await createRun("verify sandbox runtime injection");
        const claim = await getOrCreateWorkspaceSandbox({
          workspaceId,
          runId: run.id,
          timeoutMs: 60_000,
        });
        trackedSandboxes.push(claim.sandbox);

        await installAgentLoopScriptInSandbox({
          sandbox: claim.sandbox,
          apiBaseUrl: "https://example.invalid",
          runToken: tokenFor(run),
          runId: run.id,
          prompt: run.prompt,
        });

        await claim.sandbox.writeFile(
          "agent-loop-smoke.mjs",
          `
import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("agent-loop-manifest.json", "utf8"));
const script = fs.readFileSync("agent-loop.mjs", "utf8");
const forbidden = ["DATABASE_URL", "DIRECT_URL", "BETTER_AUTH_SECRET", "RUN_TOKEN_SECRET", "OPENAI_API_KEY", "EXA_API_KEY"];
console.log(JSON.stringify({
  insideSandbox: true,
  runId: manifest.runId,
  prompt: manifest.prompt,
  hasScript: script.includes("/api/llm-proxy") && script.includes("/api/ingest/events"),
  forbiddenEnvPresent: forbidden.some((key) => Boolean(process.env[key]))
}));
`.trim(),
        );
        const result = await claim.sandbox.exec("node agent-loop-smoke.mjs", {
          timeoutMs: 30_000,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain('"insideSandbox":true');
        expect(result.stdout).toContain(`"runId":"${run.id}"`);
        expect(result.stdout).toContain('"hasScript":true');
        expect(result.stdout).toContain('"forbiddenEnvPresent":false');
      },
      120_000,
    );
  },
);

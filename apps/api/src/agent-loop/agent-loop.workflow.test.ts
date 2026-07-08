import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cap/db";
import { resolveVercelCredentials } from "../sandbox/vercel-credentials.js";
import { createApp } from "../app.js";
import {
  deleteRunStream,
  disconnectRedis,
  readRunStream,
} from "../redis/streams.js";
import { issueRunToken } from "../run/run-token.js";
import {
  getOrCreateWorkspaceSandbox,
  installAgentLoopScriptInSandbox,
  runAgentLoopScriptInSandbox,
  stopWorkspaceSandboxByName,
  type WorkspaceSandboxClaim,
} from "../sandbox/workspace-sandbox.js";
import { runAgentLoop } from "./agent-loop.js";

type SseRecord = {
  event?: string;
  id?: string;
  data: string;
};

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
  process.env.PUBLIC_INGEST_BASE_URL ??
  publicUrlOrUndefined(process.env.BETTER_AUTH_URL);

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

function parseSseRecords(text: string): SseRecord[] {
  return text
    .trim()
    .split(/\n\n+/)
    .filter(Boolean)
    .map((chunk) => {
      const record: SseRecord = { data: "" };
      for (const line of chunk.split(/\n/)) {
        if (line.startsWith("event: ")) record.event = line.slice(7);
        if (line.startsWith("id: ")) record.id = line.slice(4);
        if (line.startsWith("data: ")) {
          record.data = record.data
            ? `${record.data}\n${line.slice(6)}`
            : line.slice(6);
        }
      }
      return record;
    });
}

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

describe.skipIf(!HAS_DB || !HAS_SECRET)(
  "Agent loop workflow Step 16.1/16.2（真实 Neon + fake LLM proxy + ingest/Redis/Sandbox）",
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

    async function waitForRunStatus(
      runId: string,
      predicate: (status: string) => boolean,
    ) {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const run = await prisma.agentRun.findUniqueOrThrow({
          where: { id: runId },
        });
        if (predicate(run.status)) return run;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      const run = await prisma.agentRun.findUniqueOrThrow({
        where: { id: runId },
      });
      throw new Error(`run ${runId} did not reach expected status, got ${run.status}`);
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

      const detailRes = await app.request(`/api/runs/${run.id}`, {
        headers: { cookie },
      });
      expect(detailRes.status).toBe(200);
      const detail = await detailRes.json();
      expect(
        detail.data.toolCalls.map(
          (tool: { name: string; status: string }) =>
            `${tool.name}:${tool.status}`,
        ).sort(),
      ).toEqual(["create_artifact:completed", "write_file:completed"]);
      const writeFile = detail.data.toolCalls.find(
        (tool: { name: string }) => tool.name === "write_file",
      );
      expect(writeFile.args).toMatchObject({
        path: "reports/agent-loop-report.md",
        mimeType: "text/markdown",
      });
      expect(writeFile.result).toMatchObject({
        path: "reports/agent-loop-report.md",
      });
      const createArtifact = detail.data.toolCalls.find(
        (tool: { name: string }) => tool.name === "create_artifact",
      );
      expect(createArtifact.args).toMatchObject({
        title: "Agent Loop Report",
        kind: "text",
        path: "reports/agent-loop-report.md",
      });
      expect(createArtifact.result).toMatchObject({
        title: "Agent Loop Report",
        version: 1,
      });
    });

    it.skipIf(!HAS_REDIS)("replays streamed agent loop chunks through run SSE from cursor 0", async () => {
      const run = await createRun("stream and replay through sse");

      const result = await runAgentLoop({
        runId: run.id,
        prompt: run.prompt,
        runToken: tokenFor(run),
        stream: true,
        request: (path, init) => Promise.resolve(app.request(path, init)),
      });
      expect(result.completed).toBe(true);

      const res = await app.request(`/api/runs/${run.id}/events`, {
        headers: { cookie },
      });

      expect(res.status).toBe(200);
      const records = parseSseRecords(await res.text());
      const streamChunks = records.filter(
        (record) => record.event === "stream_chunk",
      );
      expect(streamChunks).toHaveLength(2);
      expect(streamChunks.map((record) => record.id)).toEqual([
        expect.stringMatching(/^\d+-\d+$/),
        expect.stringMatching(/^\d+-\d+$/),
      ]);
      expect(
        streamChunks.map((record) => JSON.parse(record.data)),
      ).toMatchObject([
        {
          runId: run.id,
          streamType: "thinking",
          chunk: "fake reasoning for: stream and replay through sse",
        },
        {
          runId: run.id,
          streamType: "content",
          chunk: "fake response for: stream and replay through sse",
        },
      ]);
      expect(records.at(-1)?.event).toBe("done");
      expect(JSON.parse(records.at(-1)?.data ?? "{}")).toMatchObject({
        runId: run.id,
        status: "completed",
      });
    });

    it.skipIf(!HAS_REDIS)("reconnects run SSE from Last-Event-ID without duplicate or lost streamed chunks", async () => {
      const run = await createRun("stream and reconnect through sse");

      const result = await runAgentLoop({
        runId: run.id,
        prompt: run.prompt,
        runToken: tokenFor(run),
        stream: true,
        request: (path, init) => Promise.resolve(app.request(path, init)),
      });
      expect(result.completed).toBe(true);

      const streamEntries = await readRunStream({
        runId: run.id,
        cursor: "0",
        blockMs: 100,
      });
      expect(streamEntries.map((entry) => entry.streamType)).toEqual([
        "thinking",
        "content",
      ]);

      const res = await app.request(`/api/runs/${run.id}/events`, {
        headers: {
          cookie,
          "Last-Event-ID": streamEntries[0]?.id ?? "",
        },
      });

      expect(res.status).toBe(200);
      const records = parseSseRecords(await res.text());
      const streamChunks = records.filter(
        (record) => record.event === "stream_chunk",
      );
      expect(streamChunks).toHaveLength(1);
      expect(streamChunks[0]?.id).toBe(streamEntries[1]?.id);
      expect(JSON.parse(streamChunks[0]?.data ?? "{}")).toMatchObject({
        runId: run.id,
        streamType: "content",
        chunk: "fake response for: stream and reconnect through sse",
      });
      expect(
        streamChunks.some((record) => record.id === streamEntries[0]?.id),
      ).toBe(false);
      expect(records.at(-1)?.event).toBe("done");
    });

    it("runs Stage1 -> waiting_for_input -> Stage2 artifact update through the backend workflow", async () => {
      const stage1 = await createRun("stage1 overview before mechanism choice");

      const stage1Result = await runAgentLoop({
        runId: stage1.id,
        prompt: stage1.prompt,
        runToken: tokenFor(stage1),
        waitForInput: {
          question: "Which mechanism should Stage2 investigate?",
          options: ["pricing", "distribution"],
        },
        request: (path, init) => Promise.resolve(app.request(path, init)),
      });

      expect(stage1Result.completed).toBe(false);
      expect(stage1Result.waitingForInput).toBe(true);

      const waitingRun = await prisma.agentRun.findUniqueOrThrow({
        where: { id: stage1.id },
      });
      expect(waitingRun.status).toBe("waiting_for_input");

      const waitingEvent = await prisma.runEvent.findFirst({
        where: { runId: stage1.id, type: "run_waiting_for_input" },
        orderBy: { seq: "desc" },
      });
      expect(waitingEvent?.raw).toMatchObject({
        question: "Which mechanism should Stage2 investigate?",
        options: ["pricing", "distribution"],
      });

      const stage1Artifact = await prisma.workspaceArtifact.findFirstOrThrow({
        where: { runId: stage1.id, title: "Agent Loop Report" },
      });
      expect(stage1Artifact.version).toBe(1);

      const stage2 = await createRun("stage2 deep dive into pricing mechanism");
      const completedStage1 = await prisma.agentRun.findUniqueOrThrow({
        where: { id: stage1.id },
      });
      expect(completedStage1.status).toBe("completed");

      const stage2Result = await runAgentLoop({
        runId: stage2.id,
        prompt: stage2.prompt,
        runToken: tokenFor(stage2),
        updateArtifactId: stage1Artifact.id,
        request: (path, init) => Promise.resolve(app.request(path, init)),
      });

      expect(stage2Result.completed).toBe(true);
      expect(stage2Result.waitingForInput).toBe(false);

      const updatedArtifact = await prisma.workspaceArtifact.findUniqueOrThrow({
        where: { id: stage1Artifact.id },
      });
      expect(updatedArtifact.runId).toBe(stage2.id);
      expect(updatedArtifact.version).toBe(2);
      expect(updatedArtifact.contentSnapshot).toContain(
        "stage2 deep dive into pricing mechanism",
      );

      const stage2Events = await prisma.runEvent.findMany({
        where: { runId: stage2.id },
        orderBy: { seq: "asc" },
      });
      expect(stage2Events.map((event) => event.type)).toContain(
        "artifact_updated",
      );
    });

    it("stops the backend agent loop when control polling sees cancel_requested", async () => {
      const run = await createRun("cancel after llm response");
      let cancelIssued = false;

      const result = await runAgentLoop({
        runId: run.id,
        prompt: run.prompt,
        runToken: tokenFor(run),
        request: async (path, init) => {
          const response = await app.request(path, init);
          if (path === "/api/llm-proxy" && !cancelIssued) {
            cancelIssued = true;
            const cancelRes = await app.request(`/api/runs/${run.id}/cancel`, {
              method: "POST",
              headers: { cookie },
            });
            expect(cancelRes.status).toBe(200);
          }
          return response;
        },
      });

      expect(result.completed).toBe(false);
      expect(result.cancelled).toBe(true);
      expect(result.calls.map((call) => call.path)).toContain(
        `/api/runs/${run.id}/control`,
      );

      const updated = await prisma.agentRun.findUniqueOrThrow({
        where: { id: run.id },
      });
      expect(updated.status).toBe("cancelled");

      const events = await prisma.runEvent.findMany({
        where: { runId: run.id },
        orderBy: { seq: "asc" },
      });
      expect(events.map((event) => event.type)).toEqual([
        "run_created",
        "runner_started",
        "agent_started",
        "run_cancelled",
      ]);
    });

    it.skipIf(!HAS_VERCEL || !PUBLIC_API_BASE_URL)(
      "auto-starts the real Vercel Sandbox agent loop after run creation",
      async () => {
        const previousAutoStart = process.env.CAP_RUNNER_AUTO_START;
        const previousPiProvider = process.env.CAP_PI_RUNTIME_LLM_PROVIDER;
        const previousPiModelHint = process.env.CAP_PI_RUNTIME_MODEL_HINT;
        process.env.CAP_RUNNER_AUTO_START = "true";
        process.env.CAP_PI_RUNTIME_LLM_PROVIDER = "fake";
        process.env.CAP_PI_RUNTIME_MODEL_HINT = "agent-loop-step16";
        let runId = "";
        try {
          const createRes = await app.request(`/api/threads/${threadId}/runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json", cookie },
            body: JSON.stringify({
              prompt: "auto-start a sandbox architecture report",
            }),
          });
          expect(createRes.status).toBe(200);
          runId = (await createRes.json()).data.run.id as string;
          runIds.push(runId);

          const transitioned = await waitForRunStatus(
            runId,
            (status) => status !== "created",
          );
          expect(["provisioning_sandbox", "running", "completed"]).toContain(
            transitioned.status,
          );

          const completed = await waitForRunStatus(
            runId,
            (status) => status === "completed",
          );
          expect(completed.status).toBe("completed");
          expect(completed.startedAt).toBeInstanceOf(Date);

          const events = await prisma.runEvent.findMany({
            where: { runId },
            orderBy: { seq: "asc" },
          });
          expect(events.map((event) => event.type)).toEqual([
            "run_created",
            "runner_started",
            "agent_started",
            "file_written",
            "artifact_created",
            "agent_message",
            "run_completed",
          ]);

          const artifact = await prisma.workspaceArtifact.findFirst({
            where: { runId, title: "Agent Loop Report" },
          });
          expect(artifact?.version).toBe(1);

          const sseRes = await app.request(`/api/runs/${runId}/events`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              cookie,
            },
            body: JSON.stringify({}),
          });
          expect(sseRes.status).toBe(200);
          const records = parseSseRecords(await sseRes.text());
          expect(records[0]?.event).toBe("snapshot");
          expect(records.at(-1)?.event).toBe("done");
          const snapshot = JSON.parse(records[0]?.data ?? "{}");
          expect(snapshot.run.status).toBe("completed");
          expect(
            snapshot.events.map((event: { type: string }) => event.type),
          ).toEqual(events.map((event) => event.type));
        } finally {
          if (previousAutoStart === undefined) {
            delete process.env.CAP_RUNNER_AUTO_START;
          } else {
            process.env.CAP_RUNNER_AUTO_START = previousAutoStart;
          }
          if (previousPiProvider === undefined) {
            delete process.env.CAP_PI_RUNTIME_LLM_PROVIDER;
          } else {
            process.env.CAP_PI_RUNTIME_LLM_PROVIDER = previousPiProvider;
          }
          if (previousPiModelHint === undefined) {
            delete process.env.CAP_PI_RUNTIME_MODEL_HINT;
          } else {
            process.env.CAP_PI_RUNTIME_MODEL_HINT = previousPiModelHint;
          }
          if (runId) {
            const instances = await prisma.workspaceSandboxInstance.findMany({
              where: { workspaceId },
            });
            await Promise.all(
              instances.map((instance) =>
                stopWorkspaceSandboxByName(instance.sandboxName).catch(
                  () => undefined,
                ),
              ),
            );
          }
        }
      },
      240_000,
    );

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

    it.skipIf(!HAS_VERCEL || !PUBLIC_API_BASE_URL)(
      "stops the real Vercel Sandbox agent loop after cancel_requested",
      async () => {
        const run = await createRun("cancel sandbox agent loop");
        const claim = await getOrCreateWorkspaceSandbox({
          workspaceId,
          runId: run.id,
          timeoutMs: 60_000,
        });
        trackedSandboxes.push(claim.sandbox);

        const cancelRes = await app.request(`/api/runs/${run.id}/cancel`, {
          method: "POST",
          headers: { cookie },
        });
        expect(cancelRes.status).toBe(200);

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
        expect(result.stdout).toContain('"cancelled":true');
        expect(result.stdout).toContain('"llmToolCalls":0');
        expect(result.stdout).not.toContain("/api/llm-proxy");

        const updated = await prisma.agentRun.findUniqueOrThrow({
          where: { id: run.id },
        });
        expect(updated.status).toBe("cancelled");

        const released = await prisma.workspaceSandboxInstance.findUniqueOrThrow({
          where: { id: claim.instance.id },
        });
        expect(released.status).toBe("warm");
        expect(released.currentRunId).toBeNull();
      },
      180_000,
    );

    it.skipIf(!HAS_VERCEL || !PUBLIC_API_BASE_URL)(
      "maps real Vercel Sandbox agent loop exec timeout to run timeout",
      async () => {
        const run = await createRun("timeout sandbox agent loop");
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
          execTimeoutMs: 1,
        });

        expect(result.exitCode).toBe(124);
        expect(result.stderr).toMatch(/timeout|timed out|abort/i);

        const updated = await prisma.agentRun.findUniqueOrThrow({
          where: { id: run.id },
        });
        expect(updated.status).toBe("timeout");

        const released = await prisma.workspaceSandboxInstance.findUniqueOrThrow({
          where: { id: claim.instance.id },
        });
        expect(released.status).toBe("warm");
        expect(released.currentRunId).toBeNull();
      },
      180_000,
    );

    it.skipIf(!HAS_VERCEL || !PUBLIC_API_BASE_URL)(
      "runs Stage1 -> waiting_for_input -> Stage2 artifact update through real Vercel Sandbox",
      async () => {
        const stage1 = await createRun("stage1 overview before mechanism choice");
        const stage1Claim = await getOrCreateWorkspaceSandbox({
          workspaceId,
          runId: stage1.id,
          timeoutMs: 60_000,
        });
        trackedSandboxes.push(stage1Claim.sandbox);

        const stage1Result = await runAgentLoopScriptInSandbox({
          sandbox: stage1Claim.sandbox,
          apiBaseUrl: PUBLIC_API_BASE_URL!,
          runToken: tokenFor(stage1),
          runId: stage1.id,
          prompt: stage1.prompt,
          waitForInput: {
            question: "Which mechanism should Stage2 investigate?",
            options: ["pricing", "distribution"],
          },
        });

        expect(stage1Result.exitCode).toBe(0);
        expect(stage1Result.stderr).toBe("");
        expect(stage1Result.stdout).toContain('"waitingForInput":true');

        const waitingRun = await prisma.agentRun.findUniqueOrThrow({
          where: { id: stage1.id },
        });
        expect(waitingRun.status).toBe("waiting_for_input");

        const waitingEvent = await prisma.runEvent.findFirst({
          where: { runId: stage1.id, type: "run_waiting_for_input" },
          orderBy: { seq: "desc" },
        });
        expect(waitingEvent?.raw).toMatchObject({
          question: "Which mechanism should Stage2 investigate?",
          options: ["pricing", "distribution"],
        });

        const stage1Artifact = await prisma.workspaceArtifact.findFirstOrThrow({
          where: { runId: stage1.id, title: "Agent Loop Report" },
        });
        expect(stage1Artifact.version).toBe(1);

        const released = await prisma.workspaceSandboxInstance.findUniqueOrThrow({
          where: { id: stage1Claim.instance.id },
        });
        expect(released.status).toBe("warm");
        expect(released.currentRunId).toBeNull();

        const stage2 = await createRun("stage2 deep dive into pricing mechanism");
        const completedStage1 = await prisma.agentRun.findUniqueOrThrow({
          where: { id: stage1.id },
        });
        expect(completedStage1.status).toBe("completed");

        const stage2Claim = await getOrCreateWorkspaceSandbox({
          workspaceId,
          runId: stage2.id,
          timeoutMs: 60_000,
        });
        trackedSandboxes.push(stage2Claim.sandbox);
        expect(stage2Claim.reused).toBe(true);
        expect(stage2Claim.instance.id).toBe(stage1Claim.instance.id);
        expect(stage2Claim.instance.currentRunId).toBe(stage2.id);

        const stage2Result = await runAgentLoopScriptInSandbox({
          sandbox: stage2Claim.sandbox,
          apiBaseUrl: PUBLIC_API_BASE_URL!,
          runToken: tokenFor(stage2),
          runId: stage2.id,
          prompt: stage2.prompt,
          updateArtifactId: stage1Artifact.id,
        });

        expect(stage2Result.exitCode).toBe(0);
        expect(stage2Result.stderr).toBe("");
        expect(stage2Result.stdout).toContain('"waitingForInput":false');

        const completedStage2 = await prisma.agentRun.findUniqueOrThrow({
          where: { id: stage2.id },
        });
        expect(completedStage2.status).toBe("completed");

        const updatedArtifact = await prisma.workspaceArtifact.findUniqueOrThrow({
          where: { id: stage1Artifact.id },
        });
        expect(updatedArtifact.runId).toBe(stage2.id);
        expect(updatedArtifact.version).toBe(2);
        expect(updatedArtifact.contentSnapshot).toContain(
          "stage2 deep dive into pricing mechanism",
        );

        const stage2Events = await prisma.runEvent.findMany({
          where: { runId: stage2.id },
          orderBy: { seq: "asc" },
        });
        expect(stage2Events.map((event) => event.type)).toContain(
          "artifact_updated",
        );
      },
      240_000,
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

import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cap/db";
import { createApp } from "../app.js";
import { issueRunToken } from "../run/run-token.js";
import { runScriptedIngestFixture } from "./scripted-ingest-fixture.js";

// 这是 ingest route fixture，不是 sandbox 覆盖。
// 涉及 sandbox 创建、复用、runner 启动的集成测试必须使用真实 Vercel Sandbox；
// 这里保留纯 HTTP fixture 用于稳定回归 ingest/files/artifacts/sources 行为。
const HAS_DB = !!process.env.DATABASE_URL;
const HAS_SECRET = !!process.env.BETTER_AUTH_SECRET;

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
      name: "Scripted Ingest Fixture Test User",
    }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("sign-up did not set a session cookie");
  return cookie;
}

describe.skipIf(!HAS_DB || !HAS_SECRET)(
  "Scripted ingest fixture（真实 Neon + HTTP ingest，不计入 sandbox 覆盖）",
  () => {
    const app = createApp();
    const userEmail = `it-scripted-ingest-fixture-${Date.now()}@example.com`;
    let cookie = "";
    let workspaceId = "";
    let threadId = "";

    afterAll(async () => {
      const workspaces = await prisma.workspace.findMany({
        where: { title: { startsWith: "IT-ScriptedIngestFixtureWs-" } },
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
        await prisma.source.deleteMany({
          where: { workspaceId: { in: workspaceIds } },
        });
        await prisma.workspaceArtifactVersion.deleteMany({
          where: { workspaceId: { in: workspaceIds } },
        });
        await prisma.workspaceArtifact.deleteMany({
          where: { workspaceId: { in: workspaceIds } },
        });
        if (runIds.length > 0) {
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
        await prisma.workspaceFile.deleteMany({
          where: { workspaceId: { in: workspaceIds } },
        });
        await prisma.thread.deleteMany({ where: { id: { in: threadIds } } });
        await prisma.workspace.deleteMany({
          where: { id: { in: workspaceIds } },
        });
      }
      await prisma.user.deleteMany({ where: { email: userEmail } });
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
      const run = await prisma.agentRun.update({
        where: { id: runId },
        data: { status: "running" },
      });
      return run;
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
        body: JSON.stringify({ title: "IT-ScriptedIngestFixtureWs-Main" }),
      });
      workspaceId = (await wsRes.json()).data.workspace.id;

      const threadRes = await app.request(
        `/api/workspaces/${workspaceId}/threads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ title: "IT-ScriptedIngestFixtureThread" }),
        },
      );
      threadId = (await threadRes.json()).data.thread.id;

      expect(workspaceId).toBeTruthy();
      expect(threadId).toBeTruthy();
    });

    it("scripted ingest fixture completes run through ingest HTTP", async () => {
      const run = await createRun("scripted ingest fixture complete check");

      const result = await runScriptedIngestFixture({
        mode: "complete",
        runToken: tokenFor(run),
        env: { PATH: "/usr/bin" },
        request: (path, init) => Promise.resolve(app.request(path, init)),
        stepDelayMs: 1,
      });

      expect(result.completed).toBe(true);
      expect(result.forbiddenEnvPresent).toBe(false);
      expect(result.sentCookieHeader).toBe(false);
      expect(result.calls.map((call) => call.path)).toContain(
        "/api/ingest/events",
      );
      expect(result.calls.map((call) => call.path)).toContain(
        "/api/ingest/heartbeat",
      );
      expect(result.calls.map((call) => call.path)).toContain(
        "/api/ingest/tool-calls",
      );

      const updated = await prisma.agentRun.findUnique({
        where: { id: run.id },
      });
      expect(updated?.status).toBe("completed");
      expect(updated?.lastHeartbeatAt).toBeInstanceOf(Date);
      expect(updated?.phase).toBe("agent_loop");

      const events = await prisma.runEvent.findMany({
        where: { runId: run.id },
        orderBy: { seq: "asc" },
      });
      expect(events.map((event) => event.type)).toEqual([
        "run_created",
        "agent_started",
        "run_completed",
      ]);

      const toolCall = await prisma.runToolCall.findFirst({
        where: { runId: run.id },
      });
      expect(toolCall?.status).toBe("completed");
    });

    it("runner has no DB env vars or Better Auth cookie present", async () => {
      const run = await createRun("scripted ingest fixture env check");

      const result = await runScriptedIngestFixture({
        mode: "timeout",
        runToken: tokenFor(run),
        env: {
          PATH: "/usr/bin",
          DATABASE_URL: undefined,
          BETTER_AUTH_SECRET: undefined,
        },
        request: (path, init) => Promise.resolve(app.request(path, init)),
        stepDelayMs: 1,
      });

      expect(result.forbiddenEnvPresent).toBe(false);
      expect(result.sentCookieHeader).toBe(false);
      const eventCount = await prisma.runEvent.count({
        where: { runId: run.id },
      });
      expect(eventCount).toBe(2);
    });

    it("runner can be cancelled mid-execution", async () => {
      const run = await createRun("scripted ingest fixture cancel check");
      const controller = new AbortController();
      const runner = runScriptedIngestFixture({
        mode: "cancel-aware",
        runToken: tokenFor(run),
        env: { PATH: "/usr/bin" },
        signal: controller.signal,
        request: (path, init) => Promise.resolve(app.request(path, init)),
        stepDelayMs: 1,
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      const cancelRes = await app.request(`/api/runs/${run.id}/cancel`, {
        method: "POST",
        headers: { cookie },
      });
      expect(cancelRes.status).toBe(200);

      controller.abort();
      const result = await runner;

      expect(result.cancelled).toBe(true);
      const updated = await prisma.agentRun.findUnique({
        where: { id: run.id },
      });
      expect(updated?.status).toBe("cancelled");
      const finalEvent = await prisma.runEvent.findFirst({
        where: { runId: run.id },
        orderBy: { seq: "desc" },
      });
      expect(finalEvent?.type).toBe("run_cancelled");
    });

    it("scripted ingest fixture writes workspace file through ingest and file survives API reload", async () => {
      const run = await createRun("scripted ingest fixture file write check");

      const result = await runScriptedIngestFixture({
        mode: "file-write",
        runToken: tokenFor(run),
        env: { PATH: "/usr/bin" },
        request: (path, init) => Promise.resolve(app.request(path, init)),
        stepDelayMs: 1,
      });

      expect(result.completed).toBe(true);
      expect(result.calls.map((call) => call.path)).toContain(
        "/api/ingest/files",
      );

      const file = await prisma.workspaceFile.findUnique({
        where: {
          workspaceId_path: {
            workspaceId,
            path: "notes/scripted-ingest-fixture.md",
          },
        },
      });
      expect(file).toBeTruthy();
      expect(file?.latestRunId).toBe(run.id);
      expect(file?.content).toBe("scripted ingest fixture workspace note\n");

      const listRes = await app.request(`/api/workspaces/${workspaceId}/files`, {
        headers: { cookie },
      });
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json();
      expect(
        listBody.data.files.map((listed: { path: string }) => listed.path),
      ).toContain("notes/scripted-ingest-fixture.md");

      const contentRes = await app.request(
        `/api/workspaces/${workspaceId}/files/content?path=notes/scripted-ingest-fixture.md`,
        { headers: { cookie } },
      );
      expect(contentRes.status).toBe(200);
      const contentBody = await contentRes.json();
      expect(contentBody.data.content).toBe("scripted ingest fixture workspace note\n");

      const event = await prisma.runEvent.findUnique({
        where: { runId_seq: { runId: run.id, seq: 3 } },
      });
      expect(event?.type).toBe("file_written");
      expect(event?.raw).toMatchObject({
        fileId: file?.id,
        path: "notes/scripted-ingest-fixture.md",
        size: file?.size,
        contentHash: file?.contentHash,
      });
    });

    it("scripted ingest fixture creates and updates the same artifact with readable versions", async () => {
      const artifactId = `scripted-ingest-fixture-artifact-${Date.now()}`;
      const firstRun = await createRun("scripted ingest fixture artifact create");
      const first = await runScriptedIngestFixture({
        mode: "artifact-create",
        artifactId,
        artifactContent: "first artifact version\n",
        runToken: tokenFor(firstRun),
        env: { PATH: "/usr/bin" },
        request: (path, init) => Promise.resolve(app.request(path, init)),
        stepDelayMs: 1,
      });
      expect(first.completed).toBe(true);
      expect(first.calls.map((call) => call.path)).toContain(
        "/api/ingest/artifacts",
      );

      const secondRun = await createRun("scripted ingest fixture artifact update");
      const second = await runScriptedIngestFixture({
        mode: "artifact-create",
        artifactId,
        artifactContent: "second artifact version\n",
        runToken: tokenFor(secondRun),
        env: { PATH: "/usr/bin" },
        request: (path, init) => Promise.resolve(app.request(path, init)),
        stepDelayMs: 1,
      });
      expect(second.completed).toBe(true);

      const artifact = await prisma.workspaceArtifact.findUnique({
        where: { id: artifactId },
      });
      expect(artifact?.version).toBe(2);
      expect(artifact?.contentSnapshot).toBe("second artifact version\n");

      const versionsRes = await app.request(
        `/api/artifacts/${artifactId}/versions`,
        { headers: { cookie } },
      );
      expect(versionsRes.status).toBe(200);
      const versionsBody = await versionsRes.json();
      expect(
        versionsBody.data.versions.map((v: { contentSnapshot: string }) => v.contentSnapshot),
      ).toEqual(["first artifact version\n", "second artifact version\n"]);

      const updateEvent = await prisma.runEvent.findUnique({
        where: { runId_seq: { runId: secondRun.id, seq: 3 } },
      });
      expect(updateEvent?.type).toBe("artifact_updated");
      expect(updateEvent?.raw).toMatchObject({
        artifactId,
        version: 2,
        previousVersion: 1,
      });
    });

    it("scripted ingest fixture records URL and search_result sources through ingest", async () => {
      const artifactId = `scripted-ingest-fixture-source-artifact-${Date.now()}`;
      const artifactRun = await createRun("scripted ingest fixture source artifact");
      await runScriptedIngestFixture({
        mode: "artifact-create",
        artifactId,
        artifactContent: "source backed artifact\n",
        runToken: tokenFor(artifactRun),
        env: { PATH: "/usr/bin" },
        request: (path, init) => Promise.resolve(app.request(path, init)),
        stepDelayMs: 1,
      });

      const urlRun = await createRun("scripted ingest fixture url source");
      const urlResult = await runScriptedIngestFixture({
        mode: "source-record",
        artifactId,
        sourceKind: "url",
        sourceUri: "HTTPS://Example.COM/source/",
        sourceTitle: "Example Source",
        runToken: tokenFor(urlRun),
        env: { PATH: "/usr/bin" },
        request: (path, init) => Promise.resolve(app.request(path, init)),
        stepDelayMs: 1,
      });
      expect(urlResult.calls.map((call) => call.path)).toContain(
        "/api/ingest/sources",
      );

      const searchRun = await createRun("scripted ingest fixture search source");
      await runScriptedIngestFixture({
        mode: "source-record",
        sourceKind: "search_result",
        sourceUri: "https://search.example.com/result/",
        sourceTitle: "Search Result",
        runToken: tokenFor(searchRun),
        env: { PATH: "/usr/bin" },
        request: (path, init) => Promise.resolve(app.request(path, init)),
        stepDelayMs: 1,
      });

      const artifactSources = await prisma.source.findMany({
        where: { artifactId },
      });
      expect(artifactSources).toHaveLength(1);
      expect(artifactSources[0]?.uri).toBe("https://example.com/source");

      const searchSources = await prisma.source.findMany({
        where: { runId: searchRun.id, kind: "search_result" },
      });
      expect(searchSources).toHaveLength(1);
      expect(searchSources[0]?.uri).toBe(
        "https://search.example.com/result",
      );

      const detail = await app.request(`/api/artifacts/${artifactId}`, {
        headers: { cookie },
      });
      expect(detail.status).toBe(200);
      const detailBody = await detail.json();
      expect(
        detailBody.data.sources.map((source: { uri: string }) => source.uri),
      ).toContain("https://example.com/source");
    });
  },
);

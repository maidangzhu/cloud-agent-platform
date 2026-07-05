import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cap/db";
import { createApp } from "../app";
import { issueRunToken } from "../run/run-token";
import { runFakeRunner } from "./fake-runner";

// Step 9.1：本地进程模拟 fake sandbox runner，不接真实 Vercel Sandbox。
// 仍连真实 Neon + Better Auth；runner 本身只拿 scoped run token 和 HTTP
// request 函数，不导入 Prisma、不拿 DB env、不带 Better Auth cookie。
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
      name: "Fake Runner Test User",
    }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("sign-up did not set a session cookie");
  return cookie;
}

describe.skipIf(!HAS_DB || !HAS_SECRET)(
  "Fake sandbox runner helper（真实 Neon + HTTP ingest，见 Step 9.1）",
  () => {
    const app = createApp();
    const userEmail = `it-fake-runner-${Date.now()}@example.com`;
    let cookie = "";
    let workspaceId = "";
    let threadId = "";

    afterAll(async () => {
      const workspaces = await prisma.workspace.findMany({
        where: { title: { startsWith: "IT-FakeRunnerWs-" } },
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
        body: JSON.stringify({ title: "IT-FakeRunnerWs-Main" }),
      });
      workspaceId = (await wsRes.json()).data.workspace.id;

      const threadRes = await app.request(
        `/api/workspaces/${workspaceId}/threads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ title: "IT-FakeRunnerThread" }),
        },
      );
      threadId = (await threadRes.json()).data.thread.id;

      expect(workspaceId).toBeTruthy();
      expect(threadId).toBeTruthy();
    });

    it("start fake runner inside local sandbox helper and complete run through ingest HTTP", async () => {
      const run = await createRun("fake runner complete check");

      const result = await runFakeRunner({
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
      const run = await createRun("fake runner env check");

      const result = await runFakeRunner({
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
      const run = await createRun("fake runner cancel check");
      const controller = new AbortController();
      const runner = runFakeRunner({
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

    it("fake runner writes workspace file through ingest and file survives API reload", async () => {
      const run = await createRun("fake runner file write check");

      const result = await runFakeRunner({
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
            path: "notes/fake-runner.md",
          },
        },
      });
      expect(file).toBeTruthy();
      expect(file?.latestRunId).toBe(run.id);
      expect(file?.content).toBe("fake runner workspace note\n");

      const listRes = await app.request(`/api/workspaces/${workspaceId}/files`, {
        headers: { cookie },
      });
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json();
      expect(
        listBody.data.files.map((listed: { path: string }) => listed.path),
      ).toContain("notes/fake-runner.md");

      const contentRes = await app.request(
        `/api/workspaces/${workspaceId}/files/content?path=notes/fake-runner.md`,
        { headers: { cookie } },
      );
      expect(contentRes.status).toBe(200);
      const contentBody = await contentRes.json();
      expect(contentBody.data.content).toBe("fake runner workspace note\n");

      const event = await prisma.runEvent.findUnique({
        where: { runId_seq: { runId: run.id, seq: 3 } },
      });
      expect(event?.type).toBe("file_written");
      expect(event?.raw).toMatchObject({
        fileId: file?.id,
        path: "notes/fake-runner.md",
        size: file?.size,
        contentHash: file?.contentHash,
      });
    });
  },
);

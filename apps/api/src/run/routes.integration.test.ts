import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { prisma } from "@cap/db";
import { issueRunToken } from "./run-token.js";

// 连真实 Neon Postgres + 真实 Better Auth，不 mock。对应
// docs/testing-strategy.md §4.4 route 15-22、docs/implementation-roadmap.md
// Step 6.3。这一步还没有接真实 sandbox runner 调度，
// running/provisioning_sandbox/waiting_for_input 场景直接用 prisma 写状态
// 模拟，不通过真实 ingest（那是 Step 6.4/Group 8 的内容）。
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
      name: "Run Test User",
    }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("sign-up did not set a session cookie");
  return cookie;
}

describe.skipIf(!HAS_DB || !HAS_SECRET)(
  "Run 创建/查询/取消路由（真实 Neon + 真实 Better Auth，见 Step 6.3）",
  () => {
    const app = createApp();
    const userAEmail = `it-run-a-${Date.now()}@example.com`;
    const userBEmail = `it-run-b-${Date.now()}@example.com`;
    let cookieA = "";
    let cookieB = "";
    let workspaceId = "";
    let threadId = "";

    afterAll(async () => {
      const workspaces = await prisma.workspace.findMany({
        where: { title: { startsWith: "IT-RunWs-" } },
      });
      const workspaceIds = workspaces.map((w) => w.id);
      if (workspaceIds.length > 0) {
        const threads = await prisma.thread.findMany({
          where: { workspaceId: { in: workspaceIds } },
        });
        const threadIds = threads.map((t) => t.id);
        if (threadIds.length > 0) {
          await prisma.agentRun.deleteMany({
            where: { threadId: { in: threadIds } },
          });
        }
        await prisma.thread.deleteMany({
          where: { workspaceId: { in: workspaceIds } },
        });
        await prisma.workspace.deleteMany({
          where: { id: { in: workspaceIds } },
        });
      }
      await prisma.user.deleteMany({
        where: { email: { in: [userAEmail, userBEmail] } },
      });
      await prisma.$disconnect();
    });

    it("准备：注册用户 A/B，建 workspace + thread", async () => {
      cookieA = await signUpAndGetCookie(app, userAEmail);
      cookieB = await signUpAndGetCookie(app, userBEmail);

      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookieA },
        body: JSON.stringify({ title: "IT-RunWs-Main" }),
      });
      workspaceId = (await wsRes.json()).data.workspace.id;

      const threadRes = await app.request(
        `/api/workspaces/${workspaceId}/threads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie: cookieA },
          body: JSON.stringify({ title: "IT-RunThread" }),
        },
      );
      threadId = (await threadRes.json()).data.thread.id;

      expect(workspaceId).toBeTruthy();
      expect(threadId).toBeTruthy();
    });

    it("create run success", async () => {
      const res = await app.request(`/api/threads/${threadId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookieA },
        body: JSON.stringify({ prompt: "summarize this paper" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.run.status).toBe("created");
      expect(body.data.run.prompt).toBe("summarize this paper");
      expect(body.data.run.workspaceId).toBe(workspaceId);
      expect(body.data.run.threadId).toBe(threadId);
      expect(body.data.run.derivedUiState).toBe("idle");
    });

    it("create run rejects empty prompt -> VALIDATION_FAILED", async () => {
      const res = await app.request(`/api/threads/${threadId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookieA },
        body: JSON.stringify({ prompt: "" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe(1006);
    });

    it("read run detail（含 events/toolCalls/artifacts/sources）", async () => {
      const createRes = await app.request(`/api/threads/${threadId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookieA },
        body: JSON.stringify({ prompt: "detail check" }),
      });
      const runId = (await createRes.json()).data.run.id;

      const res = await app.request(`/api/runs/${runId}`, {
        headers: { cookie: cookieA },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.run.id).toBe(runId);
      expect(Array.isArray(body.data.events)).toBe(true);
      expect(Array.isArray(body.data.toolCalls)).toBe(true);
      expect(Array.isArray(body.data.artifacts)).toBe(true);
      expect(Array.isArray(body.data.sources)).toBe(true);
    });

    it("cancel running run", async () => {
      const createRes = await app.request(`/api/threads/${threadId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookieA },
        body: JSON.stringify({ prompt: "cancel running check" }),
      });
      const runId = (await createRes.json()).data.run.id;
      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: "running" },
      });

      const res = await app.request(`/api/runs/${runId}/cancel`, {
        method: "POST",
        headers: { cookie: cookieA },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.run.status).toBe("cancel_requested");
    });

    it("run control endpoint reflects cancel_requested for scoped runner token", async () => {
      const createRes = await app.request(`/api/threads/${threadId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookieA },
        body: JSON.stringify({ prompt: "runner control check" }),
      });
      const runId = (await createRes.json()).data.run.id;
      const run = await prisma.agentRun.update({
        where: { id: runId },
        data: { status: "running" },
      });
      const runToken = issueRunToken({
        userId: run.userId,
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        runId: run.id,
      });

      const before = await app.request(`/api/runs/${runId}/control`, {
        headers: { authorization: `Bearer ${runToken}` },
      });
      expect(before.status).toBe(200);
      expect((await before.json()).data).toMatchObject({
        runId,
        status: "running",
        cancelRequested: false,
        terminal: false,
      });

      const cancelRes = await app.request(`/api/runs/${runId}/cancel`, {
        method: "POST",
        headers: { cookie: cookieA },
      });
      expect(cancelRes.status).toBe(200);

      const after = await app.request(`/api/runs/${runId}/control`, {
        headers: { authorization: `Bearer ${runToken}` },
      });
      expect(after.status).toBe(200);
      expect((await after.json()).data).toMatchObject({
        runId,
        status: "cancel_requested",
        cancelRequested: true,
        terminal: false,
      });

      const unauthorized = await app.request(`/api/runs/${runId}/control`);
      expect(unauthorized.status).toBe(401);
    });

    it("cancel provisioning_sandbox run", async () => {
      const createRes = await app.request(`/api/threads/${threadId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookieA },
        body: JSON.stringify({ prompt: "cancel provisioning check" }),
      });
      const runId = (await createRes.json()).data.run.id;
      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: "provisioning_sandbox" },
      });

      const res = await app.request(`/api/runs/${runId}/cancel`, {
        method: "POST",
        headers: { cookie: cookieA },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.run.status).toBe("cancel_requested");
    });

    it("cancel waiting_for_input run（ADR-0019）", async () => {
      const createRes = await app.request(`/api/threads/${threadId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookieA },
        body: JSON.stringify({ prompt: "cancel waiting_for_input check" }),
      });
      const runId = (await createRes.json()).data.run.id;
      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: "waiting_for_input" },
      });

      const res = await app.request(`/api/runs/${runId}/cancel`, {
        method: "POST",
        headers: { cookie: cookieA },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.run.status).toBe("cancel_requested");
    });

    it("cancel terminal run rejected -> RUN_NOT_CANCELABLE", async () => {
      const createRes = await app.request(`/api/threads/${threadId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookieA },
        body: JSON.stringify({ prompt: "cancel terminal check" }),
      });
      const runId = (await createRes.json()).data.run.id;
      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: "completed" },
      });

      const res = await app.request(`/api/runs/${runId}/cancel`, {
        method: "POST",
        headers: { cookie: cookieA },
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe(2001);

      const check = await prisma.agentRun.findUnique({ where: { id: runId } });
      expect(check?.status).toBe("completed");
    });

    it("cancel already cancel_requested run rejected（非法二次转移）", async () => {
      const createRes = await app.request(`/api/threads/${threadId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookieA },
        body: JSON.stringify({ prompt: "double cancel check" }),
      });
      const runId = (await createRes.json()).data.run.id;
      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: "cancel_requested" },
      });

      const res = await app.request(`/api/runs/${runId}/cancel`, {
        method: "POST",
        headers: { cookie: cookieA },
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe(2001);
    });

    it("user B cannot read or cancel user A's run -> 404", async () => {
      const createRes = await app.request(`/api/threads/${threadId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookieA },
        body: JSON.stringify({ prompt: "cross-user check" }),
      });
      const runId = (await createRes.json()).data.run.id;

      const readRes = await app.request(`/api/runs/${runId}`, {
        headers: { cookie: cookieB },
      });
      expect(readRes.status).toBe(404);

      const cancelRes = await app.request(`/api/runs/${runId}/cancel`, {
        method: "POST",
        headers: { cookie: cookieB },
      });
      expect(cancelRes.status).toBe(404);
    });

    it(
      "creating run while a waiting_for_input run exists first completes the old run" +
        "（ADR-0019 原子收尾）",
      async () => {
        const createRes = await app.request(`/api/threads/${threadId}/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie: cookieA },
          body: JSON.stringify({ prompt: "stage1 overview" }),
        });
        const oldRunId = (await createRes.json()).data.run.id;
        await prisma.agentRun.update({
          where: { id: oldRunId },
          data: { status: "waiting_for_input" },
        });

        const newRunRes = await app.request(`/api/threads/${threadId}/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie: cookieA },
          body: JSON.stringify({ prompt: "stage2 deep dive: option A" }),
        });
        expect(newRunRes.status).toBe(200);
        const newRunBody = await newRunRes.json();
        expect(newRunBody.data.run.status).toBe("created");

        const oldRun = await prisma.agentRun.findUnique({
          where: { id: oldRunId },
        });
        expect(oldRun?.status).toBe("completed");
      },
    );

    it("cannot create run inside another user's thread", async () => {
      const wsBRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookieB },
        body: JSON.stringify({ title: "IT-RunWs-B" }),
      });
      const workspaceIdB = (await wsBRes.json()).data.workspace.id;
      const threadBRes = await app.request(
        `/api/workspaces/${workspaceIdB}/threads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie: cookieB },
          body: JSON.stringify({ title: "IT-RunThread-B" }),
        },
      );
      const threadIdB = (await threadBRes.json()).data.thread.id;

      const res = await app.request(`/api/threads/${threadIdB}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookieA },
        body: JSON.stringify({ prompt: "should not exist" }),
      });
      expect(res.status).toBe(404);
    });

    it("archived thread rejects run creation via insert-select（ADR-0018）", async () => {
      const archiveRes = await app.request(`/api/threads/${threadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", cookie: cookieA },
        body: JSON.stringify({ status: "archived" }),
      });
      expect(archiveRes.status).toBe(200);

      const res = await app.request(`/api/threads/${threadId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookieA },
        body: JSON.stringify({ prompt: "should not exist after archive" }),
      });
      expect(res.status).toBe(404);

      // 恢复为 active，避免影响后面用同一个 threadId 的用例（这个用例是
      // 最后一个用到 threadId 的，恢复只是防御性写法）。
      await prisma.thread.update({
        where: { id: threadId },
        data: { status: "active", archivedAt: null },
      });
    });

    it("unauthenticated request rejected", async () => {
      const res = await app.request(`/api/threads/${threadId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "no auth" }),
      });
      expect(res.status).toBe(401);
    });
  },
);

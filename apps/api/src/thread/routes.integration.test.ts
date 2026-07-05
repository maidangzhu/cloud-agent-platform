import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { prisma } from "@cap/db";

// 连真实 Neon Postgres + 真实 Better Auth，不 mock。对应
// docs/testing-strategy.md §4.3 route 5-13、docs/implementation-roadmap.md
// Step 5.1。
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
      name: "Thread Test User",
    }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("sign-up did not set a session cookie");
  return cookie;
}

describe.skipIf(!HAS_DB || !HAS_SECRET)(
  "Thread CRUD 路由（真实 Neon + 真实 Better Auth，见 Step 5.1）",
  () => {
    const app = createApp();
    const userAEmail = `it-thread-a-${Date.now()}@example.com`;
    const userBEmail = `it-thread-b-${Date.now()}@example.com`;
    let cookieA = "";
    let cookieB = "";
    let workspaceIdOwnedByA = "";
    let workspaceIdOwnedByB = "";
    let threadIdOwnedByA = "";

    afterAll(async () => {
      // 级联清理：先清 thread，再清 workspace，最后删用户。
      const workspaces = await prisma.workspace.findMany({
        where: { title: { startsWith: "IT-ThreadWs-" } },
      });
      const workspaceIds = workspaces.map((w) => w.id);
      if (workspaceIds.length > 0) {
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

    it("准备：注册用户 A 和用户 B，各建一个 workspace", async () => {
      cookieA = await signUpAndGetCookie(app, userAEmail);
      cookieB = await signUpAndGetCookie(app, userBEmail);
      expect(cookieA).toBeTruthy();
      expect(cookieB).toBeTruthy();

      const resA = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookieA },
        body: JSON.stringify({ title: "IT-ThreadWs-A" }),
      });
      workspaceIdOwnedByA = (await resA.json()).data.workspace.id;

      const resB = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookieB },
        body: JSON.stringify({ title: "IT-ThreadWs-B" }),
      });
      workspaceIdOwnedByB = (await resB.json()).data.workspace.id;

      expect(workspaceIdOwnedByA).toBeTruthy();
      expect(workspaceIdOwnedByB).toBeTruthy();
    });

    it("create thread inside workspace", async () => {
      const res = await app.request(
        `/api/workspaces/${workspaceIdOwnedByA}/threads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie: cookieA },
          body: JSON.stringify({}),
        },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.thread.title).toBe("New thread");
      expect(body.data.thread.status).toBe("active");
      expect(body.data.thread.workspaceId).toBe(workspaceIdOwnedByA);
      threadIdOwnedByA = body.data.thread.id;
    });

    it("create thread with explicit title", async () => {
      const res = await app.request(
        `/api/workspaces/${workspaceIdOwnedByA}/threads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie: cookieA },
          body: JSON.stringify({ title: "Explicit Title" }),
        },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.thread.title).toBe("Explicit Title");
    });

    it("create thread with initialPrompt derives title", async () => {
      const res = await app.request(
        `/api/workspaces/${workspaceIdOwnedByA}/threads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie: cookieA },
          body: JSON.stringify({ initialPrompt: "summarize this paper" }),
        },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.thread.title).toBe("summarize this paper");
    });

    it("list threads inside workspace", async () => {
      const res = await app.request(
        `/api/workspaces/${workspaceIdOwnedByA}/threads`,
        { headers: { cookie: cookieA } },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.threads.length).toBeGreaterThanOrEqual(3);
      const ids = body.data.threads.map((t: { id: string }) => t.id);
      expect(ids).toContain(threadIdOwnedByA);
    });

    it("read thread detail (includes messages and runs)", async () => {
      const res = await app.request(`/api/threads/${threadIdOwnedByA}`, {
        headers: { cookie: cookieA },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.thread.id).toBe(threadIdOwnedByA);
      expect(Array.isArray(body.data.messages)).toBe(true);
      expect(body.data.messages.length).toBe(0);
      expect(Array.isArray(body.data.runs)).toBe(true);
      expect(body.data.runs.length).toBe(0);
    });

    it("update thread title", async () => {
      const res = await app.request(`/api/threads/${threadIdOwnedByA}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", cookie: cookieA },
        body: JSON.stringify({ title: "Renamed Thread" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.thread.title).toBe("Renamed Thread");
    });

    it("cannot create thread inside another user's workspace", async () => {
      const res = await app.request(
        `/api/workspaces/${workspaceIdOwnedByB}/threads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie: cookieA },
          body: JSON.stringify({ title: "Should Not Exist" }),
        },
      );

      expect(res.status).toBe(404);
    });

    it("user A cannot access user B's thread -> 404", async () => {
      const resCreate = await app.request(
        `/api/workspaces/${workspaceIdOwnedByB}/threads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie: cookieB },
          body: JSON.stringify({ title: "IT-ThreadWs-B-Thread" }),
        },
      );
      const bThreadId = (await resCreate.json()).data.thread.id;

      const res = await app.request(`/api/threads/${bThreadId}`, {
        headers: { cookie: cookieA },
      });
      expect(res.status).toBe(404);

      const patchRes = await app.request(`/api/threads/${bThreadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", cookie: cookieA },
        body: JSON.stringify({ title: "Hijacked" }),
      });
      expect(patchRes.status).toBe(404);
    });

    it("archive thread", async () => {
      const res = await app.request(`/api/threads/${threadIdOwnedByA}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", cookie: cookieA },
        body: JSON.stringify({ status: "archived" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.thread.status).toBe("archived");

      // archived thread 仍可读（docs/state-machines.md §4）。
      const detailRes = await app.request(`/api/threads/${threadIdOwnedByA}`, {
        headers: { cookie: cookieA },
      });
      expect(detailRes.status).toBe(200);
      const detailBody = await detailRes.json();
      expect(detailBody.data.thread.status).toBe("archived");
    });

    it("unauthenticated request rejected", async () => {
      const res = await app.request(
        `/api/workspaces/${workspaceIdOwnedByA}/threads`,
      );
      expect(res.status).toBe(401);
    });
  },
);

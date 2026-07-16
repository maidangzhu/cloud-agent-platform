import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { prisma } from "@cap/db";

// 连真实 Neon Postgres + 真实 Better Auth，不 mock。对应
// docs/testing-strategy.md §4.2 route 6-15、docs/implementation-roadmap.md
// Step 4.1。
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
      name: "Workspace Test User",
    }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("sign-up did not set a session cookie");
  return cookie;
}

describe.skipIf(!HAS_DB || !HAS_SECRET)(
  "Workspace CRUD 路由（真实 Neon + 真实 Better Auth，见 Step 4.1）",
  () => {
    const app = createApp();
    const userAEmail = `it-ws-a-${Date.now()}@example.com`;
    const userBEmail = `it-ws-b-${Date.now()}@example.com`;
    const userCEmail = `it-ws-c-${Date.now()}@example.com`;
    let cookieA = "";
    let cookieB = "";
    let cookieC = "";
    let workspaceIdOwnedByA = "";

    afterAll(async () => {
      const testEmails = [userAEmail, userBEmail, userCEmail];
      const testUsers = await prisma.user.findMany({
        where: { email: { in: testEmails } },
        select: { id: true },
      });
      await prisma.workspace.deleteMany({
        where: { ownerUserId: { in: testUsers.map((user) => user.id) } },
      });
      await prisma.user.deleteMany({
        where: { email: { in: testEmails } },
      });
      await prisma.$disconnect();
    });

    it("准备：注册用户 A、B 和 C", async () => {
      cookieA = await signUpAndGetCookie(app, userAEmail);
      cookieB = await signUpAndGetCookie(app, userBEmail);
      cookieC = await signUpAndGetCookie(app, userCEmail);
      expect(cookieA).toBeTruthy();
      expect(cookieB).toBeTruthy();
      expect(cookieC).toBeTruthy();
    });

    it("first list creates exactly one default workspace", async () => {
      const first = await app.request("/api/workspaces", {
        headers: { cookie: cookieC },
      });
      const second = await app.request("/api/workspaces", {
        headers: { cookie: cookieC },
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstBody = await first.json();
      const secondBody = await second.json();
      expect(firstBody.data.workspaces).toHaveLength(1);
      expect(firstBody.data.workspaces[0].title).toBe("Research workspace");
      expect(secondBody.data.workspaces[0].id).toBe(
        firstBody.data.workspaces[0].id,
      );
    });

    it("concurrent create requests still resolve to one workspace", async () => {
      const responses = await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          app.request("/api/workspaces", {
            method: "POST",
            headers: { "Content-Type": "application/json", cookie: cookieC },
            body: JSON.stringify({ title: `Concurrent ${index}` }),
          }),
        ),
      );
      const bodies = await Promise.all(responses.map((response) => response.json()));
      const ids = new Set(bodies.map((body) => body.data.workspace.id));
      const userC = await prisma.user.findUniqueOrThrow({
        where: { email: userCEmail },
      });
      const rows = await prisma.workspace.findMany({
        where: { ownerUserId: userC.id },
      });

      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(ids.size).toBe(1);
      expect(rows).toHaveLength(1);
    });

    it("create workspace success", async () => {
      const res = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookieA },
        body: JSON.stringify({ title: "IT-Workspace-Main" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.workspace.title).toBe("IT-Workspace-Main");
      expect(body.data.workspace.status).toBe("active");
      workspaceIdOwnedByA = body.data.workspace.id;
    });

    it("create workspace rejects empty title -> VALIDATION_FAILED", async () => {
      const res = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookieA },
        body: JSON.stringify({ title: "" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe(1006);
    });

    it("list only current user's workspaces", async () => {
      await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookieB },
        body: JSON.stringify({ title: "IT-Workspace-B-Own" }),
      });

      const resA = await app.request("/api/workspaces", {
        headers: { cookie: cookieA },
      });
      const bodyA = await resA.json();
      const titlesA = bodyA.data.workspaces.map((w: { title: string }) => w.title);
      expect(titlesA).toContain("IT-Workspace-Main");
      expect(titlesA).not.toContain("IT-Workspace-B-Own");
    });

    it("list excludes archived by default", async () => {
      const res = await app.request("/api/workspaces", {
        headers: { cookie: cookieA },
      });
      const body = await res.json();
      const archived = body.data.workspaces.filter(
        (w: { status: string }) => w.status === "archived",
      );
      expect(archived.length).toBe(0);
    });

    it("read workspace detail", async () => {
      const res = await app.request(`/api/workspaces/${workspaceIdOwnedByA}`, {
        headers: { cookie: cookieA },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.workspace.id).toBe(workspaceIdOwnedByA);
    });

    it("update workspace title", async () => {
      const res = await app.request(`/api/workspaces/${workspaceIdOwnedByA}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", cookie: cookieA },
        body: JSON.stringify({ title: "IT-Workspace-Renamed" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.workspace.title).toBe("IT-Workspace-Renamed");
    });

    it("user A cannot read user B's workspace -> 404", async () => {
      const listRes = await app.request("/api/workspaces", {
        headers: { cookie: cookieB },
      });
      const listBody = await listRes.json();
      const bWorkspaceId = listBody.data.workspaces.find(
        (w: { title: string }) => w.title === "IT-Workspace-B-Own",
      )?.id;
      expect(bWorkspaceId).toBeTruthy();

      const res = await app.request(`/api/workspaces/${bWorkspaceId}`, {
        headers: { cookie: cookieA },
      });

      expect(res.status).toBe(404);
    });

    it("user A cannot archive user B's workspace", async () => {
      const listRes = await app.request("/api/workspaces", {
        headers: { cookie: cookieB },
      });
      const listBody = await listRes.json();
      const bWorkspaceId = listBody.data.workspaces.find(
        (w: { title: string }) => w.title === "IT-Workspace-B-Own",
      )?.id;

      const res = await app.request(`/api/workspaces/${bWorkspaceId}`, {
        method: "DELETE",
        headers: { cookie: cookieA },
      });

      expect(res.status).toBe(404);

      // 确认没有被误归档
      const check = await prisma.workspace.findUnique({
        where: { id: bWorkspaceId },
      });
      expect(check?.status).toBe("active");
    });

    it("archive workspace (soft delete)", async () => {
      const res = await app.request(`/api/workspaces/${workspaceIdOwnedByA}`, {
        method: "DELETE",
        headers: { cookie: cookieA },
      });

      expect(res.status).toBe(200);

      const check = await prisma.workspace.findUnique({
        where: { id: workspaceIdOwnedByA },
      });
      expect(check?.status).toBe("archived");
      expect(check?.archivedAt).not.toBeNull();
    });

    it("archived workspace still readable, no longer in default list", async () => {
      const detailRes = await app.request(
        `/api/workspaces/${workspaceIdOwnedByA}`,
        { headers: { cookie: cookieA } },
      );
      expect(detailRes.status).toBe(200);

      const listRes = await app.request("/api/workspaces", {
        headers: { cookie: cookieA },
      });
      const listBody = await listRes.json();
      const ids = listBody.data.workspaces.map((w: { id: string }) => w.id);
      expect(ids).not.toContain(workspaceIdOwnedByA);

      const listWithArchivedRes = await app.request(
        "/api/workspaces?includeArchived=true",
        { headers: { cookie: cookieA } },
      );
      const listWithArchivedBody = await listWithArchivedRes.json();
      const idsWithArchived = listWithArchivedBody.data.workspaces.map(
        (w: { id: string }) => w.id,
      );
      expect(idsWithArchived).toContain(workspaceIdOwnedByA);
    });

    it("unauthenticated request rejected", async () => {
      const res = await app.request("/api/workspaces");
      expect(res.status).toBe(401);
    });
  },
);

import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
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
    let cookieA = "";
    let cookieB = "";
    let workspaceIdOwnedByA = "";

    afterAll(async () => {
      // 级联清理：删用户前先清所有测试期间创建的 workspace，再删用户。
      await prisma.workspace.deleteMany({
        where: { title: { startsWith: "IT-Workspace-" } },
      });
      await prisma.user.deleteMany({
        where: { email: { in: [userAEmail, userBEmail] } },
      });
      await prisma.$disconnect();
    });

    it("准备：注册用户 A 和用户 B", async () => {
      cookieA = await signUpAndGetCookie(app, userAEmail);
      cookieB = await signUpAndGetCookie(app, userBEmail);
      expect(cookieA).toBeTruthy();
      expect(cookieB).toBeTruthy();
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

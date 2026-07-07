import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { prisma } from "@cap/db";

// 连真实 Neon Postgres + 真实 Better Auth 逻辑，不 mock。无 DATABASE_URL/
// BETTER_AUTH_SECRET（如 CI 未配）则整组跳过，不报错。运行：pnpm test:integration
//
// 对应 docs/testing-strategy.md §4.1 Auth unit 1-3——这里改成集成测试而不是
// unit test，因为按项目规矩（不 mock 任何数据库/沙箱/Redis 连接），
// "current user helper" 的行为离不开真实数据库查询，没有可以脱离数据库的
// 纯逻辑版本。
const HAS_DB = !!process.env.DATABASE_URL;
const HAS_SECRET = !!process.env.BETTER_AUTH_SECRET;

describe.skipIf(!HAS_DB || !HAS_SECRET)(
  "Better Auth 集成（真实 Neon + 真实 Better Auth，见 Step 3.1）",
  () => {
    const app = createApp();
    const testEmail = `it-${Date.now()}@example.com`;
    const webOriginEmail = `it-web-origin-${Date.now()}@example.com`;
    const webFallbackOriginEmail = `it-web-origin-fallback-${Date.now()}@example.com`;
    const testPassword = "integration-test-password-123";
    let sessionCookie = "";

    afterAll(async () => {
      // 清理测试账号，保持远端库干净（同 db.integration.test.ts 的约定）。
      await prisma.user.deleteMany({
        where: {
          email: { in: [testEmail, webOriginEmail, webFallbackOriginEmail] },
        },
      });
      await prisma.$disconnect();
    });

    it("注册新用户成功，返回 token 和 user，并设置 session cookie", async () => {
      const res = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: testEmail,
          password: testPassword,
          name: "Integration Test User",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.email).toBe(testEmail);
      expect(body.token).toBeTruthy();

      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toContain("better-auth.session_token=");
      sessionCookie = setCookie?.split(";")[0] ?? "";
    });

    it("已存在账号可以用邮箱密码登录", async () => {
      const res = await app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: testEmail, password: testPassword }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.email).toBe(testEmail);
    });

    it("带合法 session cookie 查询 get-session 返回当前用户", async () => {
      const res = await app.request("/api/auth/get-session", {
        headers: { cookie: sessionCookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user.email).toBe(testEmail);
      expect(body.session.userId).toBe(body.user.id);
    });

    it("不带 cookie 查询 get-session 返回 null（未登录）", async () => {
      const res = await app.request("/api/auth/get-session");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toBeNull();
    });

    it("错误密码登录被拒绝", async () => {
      const res = await app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: testEmail, password: "wrong-password" }),
      });

      expect(res.status).toBe(401);
    });

    it("重复邮箱注册被拒绝", async () => {
      const res = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: testEmail,
          password: "another-password-456",
          name: "Duplicate",
        }),
      });

      expect(res.status).toBe(422);
    });

    it("允许 apps/web 本地 origin 注册账号", async () => {
      for (const [origin, email] of [
        ["http://localhost:3000", webOriginEmail],
        ["http://localhost:3001", webFallbackOriginEmail],
      ] as const) {
        const res = await app.request("/api/auth/sign-up/email", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            origin,
          },
          body: JSON.stringify({
            email,
            password: testPassword,
            name: "Web Origin User",
          }),
        });

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.user.email).toBe(email);
      }
    });

    it("认证 session 落在独立的 AuthSession 表，不污染 v1 业务 Session 表", async () => {
      // 回归测试：ADR-0022/Step 3.1 踩过的坑——@better-auth/cli generate 默认
      // 会把认证 session 合并进 v1 已有的业务 Session model。这条测试确认
      // 两者是独立的表，AuthSession 里能查到刚创建的记录。
      const authSessions = await prisma.authSession.findMany({
        where: { user: { email: testEmail } },
      });
      expect(authSessions.length).toBeGreaterThan(0);
    });
  },
);

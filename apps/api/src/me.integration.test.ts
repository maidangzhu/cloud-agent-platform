import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { prisma } from "@cap/db";

// 连真实 Neon Postgres + 真实 Better Auth，不 mock。对应
// docs/testing-strategy.md §4.1 route 测试 4-7、
// docs/implementation-roadmap.md Step 3.2。
const HAS_DB = !!process.env.DATABASE_URL;
const HAS_SECRET = !!process.env.BETTER_AUTH_SECRET;

describe.skipIf(!HAS_DB || !HAS_SECRET)(
  "GET /api/me（真实 Neon + 真实 Better Auth，见 Step 3.2）",
  () => {
    const app = createApp();
    const testEmail = `it-me-${Date.now()}@example.com`;
    const testPassword = "integration-test-password-456";

    afterAll(async () => {
      await prisma.user.deleteMany({ where: { email: testEmail } });
      await prisma.$disconnect();
    });

    it("未登录返回 401", async () => {
      const res = await app.request("/api/me");

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe(1002);
      expect(body.data).toBeNull();
    });

    it("已登录返回 user（不含 credits，见 ADR-0015）", async () => {
      const signUpRes = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: testEmail,
          password: testPassword,
          name: "Me Test User",
        }),
      });
      const sessionCookie = signUpRes.headers
        .get("set-cookie")
        ?.split(";")[0];
      expect(sessionCookie).toBeTruthy();

      const res = await app.request("/api/me", {
        headers: { cookie: sessionCookie! },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.code).toBe(0);
      expect(body.data.user.email).toBe(testEmail);
      expect(body.data.user.name).toBe("Me Test User");
      expect(body.data).not.toHaveProperty("credits");
    });

    it("过期/无效 cookie 视为未登录，返回 401", async () => {
      const res = await app.request("/api/me", {
        headers: { cookie: "better-auth.session_token=invalid-token-value" },
      });

      expect(res.status).toBe(401);
    });
  },
);

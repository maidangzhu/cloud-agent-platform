import { describe, expect, it } from "vitest";
import { createApp } from "./app";

// Step 2.2 的第一条自动化测试：验证 Hono app 本身可测试
// （不需要起真实 HTTP server，直接调 app.fetch）。
describe("GET /health", () => {
  it("returns 200 and { ok: true }", async () => {
    const app = createApp();
    const res = await app.request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

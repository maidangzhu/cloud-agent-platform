import { Hono } from "hono";

// 最小 Hono app：目前只有一个 health check 路由，用于验证 Step 2.2
// 的部署链路（本地 dev server + 路由测试）打通。业务路由从 Group 3
// （Auth）开始逐个迁移进来，见 docs/implementation-roadmap.md。
export function createApp() {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  return app;
}

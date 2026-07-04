import { Hono } from "hono";
import { auth } from "./auth";

// Hono app。Step 2.2 起了 health check；Step 3.1 挂载 Better Auth
// （官方 Hono 集成方式：app.on(["POST","GET"], "/api/auth/*", ...)，
// 见 https://better-auth.com/docs/integrations/hono）。
export function createApp() {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  return app;
}

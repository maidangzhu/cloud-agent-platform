import { Hono } from "hono";
import { auth } from "./auth";
import { requireUser } from "./require-user";
import { workspaceRoutes } from "./workspace/routes";

// Hono app。Step 2.2 起了 health check；Step 3.1 挂载 Better Auth
// （官方 Hono 集成方式：app.on(["POST","GET"], "/api/auth/*", ...)，
// 见 https://better-auth.com/docs/integrations/hono）；
// Step 3.2 新增 GET /api/me（受保护路由，见 docs/api-contract.md §5.1）；
// Step 4.1 新增 Workspace CRUD（见 docs/api-contract.md §5.2）。
export function createApp() {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  app.get("/api/me", async (c) => {
    const user = await requireUser(c);
    if (user instanceof Response) return user;
    return c.json({ code: 0, message: "ok", data: { user } });
  });

  app.route("/", workspaceRoutes);

  return app;
}

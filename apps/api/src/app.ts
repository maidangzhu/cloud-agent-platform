import { Hono } from "hono";
import { auth } from "./auth";
import { requireUser } from "./require-user";
import { workspaceRoutes } from "./workspace/routes";
import { threadRoutes } from "./thread/routes";
import { runRoutes } from "./run/routes";

// Hono app。Step 2.2 起了 health check；Step 3.1 挂载 Better Auth
// （官方 Hono 集成方式：app.on(["POST","GET"], "/api/auth/*", ...)，
// 见 https://better-auth.com/docs/integrations/hono）；
// Step 3.2 新增 GET /api/me（受保护路由，见 docs/api-contract.md §5.1）；
// Step 4.1 新增 Workspace CRUD（见 docs/api-contract.md §5.2）；
// Step 5.1 新增 Thread CRUD（见 docs/api-contract.md §5.3）；
// Step 6.3 新增 Run 创建/查询/取消（见 docs/api-contract.md §5.4，此时
// 还没有真实 sandbox，run 会一直停在 created，Group 9 才接 fake runner）。
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
  app.route("/", threadRoutes);
  app.route("/", runRoutes);

  return app;
}

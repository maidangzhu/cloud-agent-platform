import { Hono } from "hono";
import { auth } from "./auth";
import { requireUser } from "./require-user";
import { workspaceRoutes } from "./workspace/routes";
import { threadRoutes } from "./thread/routes";
import { runRoutes } from "./run/routes";
import { ingestRoutes } from "./ingest/routes";
import { fileRoutes } from "./files/routes";
import { artifactRoutes } from "./artifacts/routes";
import { sourceRoutes } from "./sources/routes";

// Hono app。Step 2.2 起了 health check；Step 3.1 挂载 Better Auth
// （官方 Hono 集成方式：app.on(["POST","GET"], "/api/auth/*", ...)，
// 见 https://better-auth.com/docs/integrations/hono）；
// Step 3.2 新增 GET /api/me（受保护路由，见 docs/api-contract.md §5.1）；
// Step 4.1 新增 Workspace CRUD（见 docs/api-contract.md §5.2）；
// Step 5.1 新增 Thread CRUD（见 docs/api-contract.md §5.3）；
// Step 6.3 新增 Run 创建/查询/取消（见 docs/api-contract.md §5.4，此时
// 还没有真实 sandbox，run 会一直停在 created，Group 9 才接 fake runner）；
// Step 8.1 新增 ingest events/heartbeat（scoped run token 认证）。
// Step 10.1 新增 WorkspaceFile ingest + 查询路由。
// Step 11.1 新增 Artifact 首次创建 ingest + 查询路由。
// Step 12.1 新增 Source ingest + 查询路由。
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
  app.route("/", fileRoutes);
  app.route("/", artifactRoutes);
  app.route("/", sourceRoutes);
  app.route("/", ingestRoutes);

  return app;
}

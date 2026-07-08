import { Hono } from "hono";
import type { Context } from "hono";
import { handle } from "hono/vercel";
import { cors } from "hono/cors";
import { auth } from "./auth.js";
import { isAllowedCorsOrigin } from "./origins.js";
import { requireUser } from "./require-user.js";
import { workspaceRoutes } from "./workspace/routes.js";
import { threadRoutes } from "./thread/routes.js";
import { runRoutes } from "./run/routes.js";
import { ingestRoutes } from "./ingest/routes.js";
import { fileRoutes } from "./files/routes.js";
import { artifactRoutes } from "./artifacts/routes.js";
import { sourceRoutes } from "./sources/routes.js";
import { llmRoutes } from "./llm/routes.js";
import { searchRoutes } from "./search/routes.js";
import { usageRoutes } from "./usage/routes.js";
import { sweepRoutes } from "./sweep/routes.js";

// Hono app。Step 2.2 起了 health check；Step 3.1 挂载 Better Auth
// （官方 Hono 集成方式：app.on(["POST","GET"], "/api/auth/*", ...)，
// 见 https://better-auth.com/docs/integrations/hono）；
// Step 3.2 新增 GET /api/me（受保护路由，见 docs/api-contract.md §5.1）；
// Step 4.1 新增 Workspace CRUD（见 docs/api-contract.md §5.2）；
// Step 5.1 新增 Thread CRUD（见 docs/api-contract.md §5.3）；
// Step 6.3 新增 Run 创建/查询/取消（见 docs/api-contract.md §5.4，此时
// 还没有真实 sandbox runner 调度，run 会一直停在 created；
// Step 8.1 新增 ingest events/heartbeat（scoped run token 认证）。
// Step 10.1 新增 WorkspaceFile ingest + 查询路由。
// Step 11.1 新增 Artifact 首次创建 ingest + 查询路由。
// Step 12.1 新增 Source ingest + 查询路由。
// Step 14.1 新增 LLM proxy fake provider 路由。
// Step 15.1 新增 Search proxy fake provider 路由。
// Step 17.1 新增 usage telemetry 查询路由。
// Step 18.4 新增 sweep cron 入口（run 收敛 + 孤儿资源清理）。
export function createApp() {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: (origin) => (isAllowedCorsOrigin(origin) ? origin : null),
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "Last-Event-ID"],
      exposeHeaders: ["Content-Type", "Last-Event-ID"],
      credentials: true,
      maxAge: 600,
    }),
  );

  const health = (c: Context) => c.json({ ok: true });
  app.get("/health", health);
  app.get("/api/health", health);

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
  app.route("/", llmRoutes);
  app.route("/", searchRoutes);
  app.route("/", usageRoutes);
  app.route("/", sweepRoutes);

  return app;
}

const handler = handle(createApp());

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;

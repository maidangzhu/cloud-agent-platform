# Hosted Control Plane Deployment Plan

本文档是当前优先级最高的执行计划。目标不是先继续修 UI，而是先把 `apps/api` 的 Hono Control Plane 作为独立 hosted 服务部署到 Vercel，让本地和线上 `apps/web` 都能打到同一个公网 API，跑通真实数据库、真实 Redis、真实 Vercel Sandbox、真实 provider 的链路。

## 1. 当前问题

- 仓库根目录不应再作为 Vercel 项目的 Next.js root。`apps/web` 才是 Next.js 应用，`apps/api` 才是 Hono API。根目录只保留 pnpm workspace、共享脚本和包管理信息。
- 根目录 `vercel.json` 会让 Vercel 零配置检测和构建命令继续混用旧的单应用假设。每个 deployable app 应该有自己的 Vercel 配置。
- `apps/api` 目前只有本地 `tsx watch src/index.ts` + `@hono/node-server` 入口，没有 Vercel Hono zero-config 入口（default export Hono app）。
- `apps/web/next.config.ts` 的默认 `API_PROXY_TARGET` 是 `http://localhost:8787`。本地开发可以这样，但线上必须指向 hosted `apps/api`。
- 当前 `apps/api/src/agent-loop/*` 是项目内自写 loop。产品方向改为在 sandbox 内运行真实 Pi AI runtime（`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`）；自写 loop 只能作为临时 fixture/迁移垫片，不能作为最终 Agent Runtime。

## 2. 目标拓扑

```text
Vercel project: cloud-agent-platform-web
  Root Directory: apps/web
  Framework: Next.js
  API_PROXY_TARGET: https://<api-host>

Vercel project: cloud-agent-platform-api
  Root Directory: apps/api
  Framework: Other / Hono serverless function
  Public health: https://<api-host>/health
  API routes: https://<api-host>/api/*

Workspace root
  pnpm workspace only
  no root Vercel app config
```

`apps/web` 和 `apps/api` 保持两个独立 Vercel 项目，符合 [ADR-0022](./decisions/0022-monorepo-hono-backend.md)。公网 API 是 sandbox 回调 Control Plane 的唯一可信入口；Vercel Sandbox 内不能依赖本机 `localhost`。

## 3. 执行顺序

### Step A：整理部署配置边界

1. 将根目录 `vercel.json` 的职责迁到 app 级配置：`apps/web/vercel.json`、`apps/api/vercel.json`。
2. 根目录不再声明任何会让 Vercel 把仓库根当作 Next.js app 的配置。
3. 保留根 `package.json` 作为 workspace 脚本入口，但 Vercel 项目构建时优先使用对应 app 的 root 和脚本。

验证：

- `git diff` 中根 `vercel.json` 不再作为 deploy target。
- `apps/web` 构建仍能运行 `pnpm --filter @cap/web build` 或等价 build。
- `apps/api` 有明确 serverless entry 和 build/typecheck 命令。

### Step B：让 `apps/api` 可部署到 Vercel

1. 新增 Vercel Hono entry，例如 `apps/api/src/server.ts`，default export Hono app。
2. 不新增不存在的 `@hono/vercel` dependency；Vercel 通过 Hono zero-config 检测入口。
3. 保留 `apps/api/src/index.ts` 的本地 `@hono/node-server` dev 入口，不把本地 dev 和 Vercel entry 混在一起。
4. 确认 `/health`、`/api/me`、`/api/ingest/*`、`/api/runs/*` 在 Vercel runtime 下路由一致。

验证：

- `pnpm --filter @cap/api typecheck`
- `pnpm --filter @cap/api test`
- `vercel deploy --cwd apps/api` 或链接后的等价 preview deploy
- `curl https://<api-preview>/health`
- `pnpm --dir apps/api test:live`，以 `CAP_API_BASE_URL=https://<api-preview>` 运行 deployed API smoke。

### Step C：创建独立 API Vercel 项目

这一步会新建计费/部署资源，执行前必须和用户确认：

- Vercel 项目名：建议 `cloud-agent-platform-api`。
- API 域名：先用 Vercel preview/production 默认域名，还是绑定 `api.sandbox.maidang.me`。
- Web 域名：是否同步绑定 `app.sandbox.maidang.me`，以便后续 cookie domain 配成 `.sandbox.maidang.me`。

确认后再做：

1. 创建/链接 `apps/api` 项目，Root Directory 设为 `apps/api`。
2. 迁移环境变量：`DATABASE_URL`、`BETTER_AUTH_SECRET`、`BETTER_AUTH_URL`、`REDIS_URL`、`OPENAI_*`、`EXA_API_KEY`、`VERCEL_TOKEN` 或 `VERCEL_OIDC_TOKEN` 相关配置。
3. 不在本地日志或提交里打印任何 secret 值。只能验证 key 名是否存在、部署是否能读取。

验证：

- API preview deploy 状态为 Ready。
- `https://<api-host>/health` 公网 200。
- 未登录 `https://<api-host>/api/me` 返回预期 401/unauthenticated contract。
- live smoke 可以命中 deployed API。

### Step D：把 Web 指向 Hosted API

1. `apps/web` Vercel 项目 Root Directory 固定为 `apps/web`。
2. `apps/web` 项目设置 `API_PROXY_TARGET=https://<api-host>`。
3. 保持本地默认 `API_PROXY_TARGET=http://localhost:8787`，但需要真实 sandbox 回调的 workflow/live 测试必须显式使用公网 API base。

验证：

- Web preview deploy 状态为 Ready，不再出现 `No Next.js version detected`。
- 线上 web 的 `/api/health` rewrite 指向 hosted API。
- 登录后首页能加载 workspace snapshot；首页默认状态按 UX 要求保持空 composer，不自动选中历史 thread。
- 发送首条消息后创建/选中新 thread，左侧 thread 列表出现。

### Step E：替换自写 Agent Loop 为 Pi AI Runtime

当前 `apps/api/src/agent-loop/*` 可以继续作为 deterministic fixture 和迁移基线，但最终 sandbox 内 runtime 必须替换为 Pi AI（`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`）。

拆分步骤：

1. 调研并固定 Pi AI runtime 的安装、启动、配置和 tool adapter 方式。
2. 定义 Pi AI 与 Control Plane 的 adapter：ingest client、LLM proxy client、search/fetch/file/artifact tools、cancel polling、heartbeat。
3. 在 sandbox 内启动 Pi AI runtime，而不是启动项目内自写 loop。
4. 保留 deterministic mode，便于 workflow/live 测试稳定断言。
5. 删除或降级自写 loop 为测试 fixture，不再作为产品主路径。

验证：

- 真实 Vercel Sandbox 内 Pi AI runtime 能调用 hosted ingest/LLM/search API。
- `WF-010`、`LIVE-005`、`LIVE-006` 从 planned/partial 推进到 done。
- 隐私扫描确认 sandbox 环境不含 DB/Auth/LLM provider 长期凭证。

## 4. 本轮阻塞点

在执行 Step C 之前必须人工确认域名和 Vercel 项目命名。没有确认前，只能完成代码/文档/本地验证，不能新建 API 项目或绑定域名。

## 5. 完成定义

- `apps/api` 线上 Ready，`/health` 公网可访问。
- `apps/web` 线上 Ready，Root Directory 为 `apps/web`，不再从仓库根检测 Next.js。
- 线上 web 的 API rewrite 指向 hosted API，不指向 `localhost:8787`。
- sandbox 回调使用 hosted API base URL，生产链路不依赖本地 Hono。
- 首页默认空 composer 的 UX bug 修复并通过手动验证。
- Pi AI runtime 替换工作已进入独立排期，不再把自写 loop 视为最终产品 runtime。

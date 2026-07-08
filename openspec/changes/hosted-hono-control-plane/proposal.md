# Proposal — Hosted Hono Control Plane

## Why

当前前端和 sandbox 主链路无法依赖本地 Hono 服务：Vercel Sandbox 运行在生产级云环境里，回调 Control Plane 时必须访问公网 API。`apps/web` 线上也不能继续把 `/api/*` rewrite 到 `localhost:8787`。因此必须先把 `apps/api` 作为独立 hosted Hono 服务部署到 Vercel，再验证真实数据库、Redis、Vercel Sandbox、LLM/Search provider 的完整链路。

另一个问题是仓库根目录仍残留单 Next.js app 的部署假设。v2 已经是 pnpm workspace：`apps/web` 是 Next.js，`apps/api` 是 Hono，根目录不能再作为 Vercel 零配置检测的应用 root。

同时，当前自写 `apps/api/src/agent-loop/*` 只能作为协议 fixture。产品主路径必须迁移到 sandbox 内真实 Pi AI runtime（`@earendil-works/pi`）。

## What Changes

- 根目录退出 Vercel app root 角色；部署配置下沉到 `apps/web` 和 `apps/api`。
- `apps/api` 增加 Vercel Hono zero-config 入口，保留本地 node-server dev 入口。
- 新建独立 API Vercel 项目，Root Directory 为 `apps/api`。
- `apps/web` Vercel 项目 Root Directory 固定为 `apps/web`，并通过 `API_PROXY_TARGET` 指向 hosted API。
- live/workflow 验证改为以 hosted API base URL 为准。
- Pi AI runtime 替换自写 loop 进入明确排期。

## Capabilities

### New Capabilities

- `hosted-control-plane-deployment`：两个独立 Vercel 项目、app 级 deploy config、hosted API health/live smoke、web rewrite 指向 hosted API。
- `pi-ai-agent-runtime`：sandbox 内真实 Pi AI runtime 启动、Control Plane adapter、deterministic mode、替换产品主路径。

### Modified Capabilities

- `monorepo-hono-backend`：补充根目录不作为 Vercel app root 的约束。
- `sandbox-orchestration`：产品主路径从自写 loop 收敛为 Pi AI runtime。

## Impact

- 受影响代码：根 `vercel.json`、`apps/web` Vercel 配置、`apps/api` Vercel entry、`apps/api/package.json`。
- 受影响文档：`docs/hosted-control-plane-deployment-plan.md`、`docs/implementation-roadmap.md`、`docs/technical-design.md`、`docs/agent-runtime-protocol.md`、`docs/testing-case-catalog.md`。
- 受影响外部资源：新增 `apps/api` Vercel 项目；迁移 API 侧环境变量；后续可选绑定 `api.sandbox.maidang.me`。
- 需要人工确认：API 项目命名、API 域名、是否同时设置 web 自定义域名和 cookie domain。

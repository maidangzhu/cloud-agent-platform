# ADR-0022：后端采用 Hono，项目重构为 pnpm workspaces monorepo

**状态：** 已接受（2026-07-03）

## 决策

拆分成 monorepo，后端框架从 Next.js API routes 迁移到独立的 Hono 应用：

```text
apps/web         Next.js 前端（App Router），只做 UI，不再包含任何 /api route
apps/api         Hono 后端（Control Plane 全部业务逻辑：auth、workspace/thread/run、
                 ingest、LLM proxy、search proxy、SSE），部署为 Vercel Serverless
                 Function（@hono/vercel adapter）
packages/shared  前后端共享的 TS 类型/DTO/zod schema —— api-contract.md 里定义的
                 每个 DTO 在这里定义一次，前后端 import 同一份，不再依赖
                 "两份手写类型碰巧一致"
packages/db      Prisma schema + client，只被 apps/api 依赖，前端不直接访问 Prisma
```

Monorepo 工具：**纯 pnpm workspaces**，不引入 Turborepo（当前 2 个 app + 2 个 package 的规模，构建缓存/任务编排收益覆盖不了配置成本；以后包数明显增多再加）。

Auth（Better Auth）**挂在 `apps/api`**：Control Plane 概念上后端本就拥有 auth，让 Hono 直接管理 Better Auth session，比"Next.js 前端管 auth、Hono 只做业务、每次请求多一层内部 token 转发"更直接。

部署形态：`apps/web` 和 `apps/api` 各自作为独立 Vercel 项目/应用部署，同属一个 Vercel 团队/组织，生产环境走同一根域名的不同 subdomain（如 `app.example.com` 前端、`api.example.com` 后端），Better Auth cookie domain 设为 `.example.com`，`SameSite=Lax` 即可正常跨 subdomain 共享登录态。

**本地开发的跨域 cookie 问题**：`apps/web`（如 `:3000`）和 `apps/api`（如 `:8787`）本地是不同 port，浏览器视为不同 origin，跨源 cookie 需要 `SameSite=None; Secure`，而 `Secure` 要求 HTTPS，本地默认没有。默认解法：`apps/web` 的 `next.config.ts` 增加一条 rewrite，把 `/api/*` 代理到本地 Hono 端口，让浏览器在本地开发时只看到一个 origin，不触发跨域 cookie 问题。生产环境不需要这层代理（走合法 subdomain cookie 共享）。这是按经验选的默认值，实现阶段如遇到具体问题可以调整。

## 背景

用户在这轮讨论中补充了一个此前未提及的基础架构决策：后端要用 Hono，整体项目要改成 monorepo。此前所有文档（PRD、api-contract.md、agent-runtime-protocol.md 等）里的"Control Plane"默认隐含指向当前分支上的 Next.js API routes（`src/app/api/*`）。这条 ADR 把 Control Plane 的实际代码归属从"Next.js app 内嵌"改为"独立 Hono app"，是一条会重塑目录结构和后续所有实现 Phase 顺序的决策，因此单独立卡，且排在协议/状态机类 ADR（0018~0021）之前——那几条决策的内容不依赖代码物理位置，但本 ADR 决定了后续 Phase 从哪个目录开始写。

## 被否方案

- **Turborepo**：当前规模（2 app + 2 package）用不到跨包构建缓存/任务图编排的收益，引入只会增加一层学习和配置成本。
- **Auth 挂在 Next.js 前端**：会让 `apps/api` 的每个受保护端点都多一层"验证 Next.js 转发的内部 token"的间接性，不如让 Hono 直接管理 Better Auth session。
- **本地开发强制 HTTPS 双端**：技术上可行（本地自签证书），但比 rewrite 代理复杂得多，对于"减少跨域 cookie 坑"这个单一目的过度设计。

## 连锁影响（范围最大，需要专门的迁移阶段）

现有 v1 代码（`src/app/api/*`、`src/server/*` 全部内容、`prisma/schema.prisma`）需要整体搬迁到新目录结构，这不是文档校订阶段能顺带完成的，需要在执行路线图（[research-agent-tdd-roadmap.md](../research-agent-tdd-roadmap.md)）插入一个新的最早期阶段 **Phase 0.5：Monorepo 脚手架**，排在"Better Auth"（原 Phase 2）之前——因为 Better Auth 现在要挂在一个还不存在的 `apps/api` 里。该 Phase 拆成更小步骤（搭 pnpm workspace 空壳 → 迁移 Prisma 到 `packages/db` → 起一个只有 health check 的 Hono app 验证部署链路通 → 迁移 Better Auth → 逐个搬迁业务路由），每步独立验证，不一次性搬完。

其余受影响文档：

- `backend-domain-model.md` §4 服务边界描述里"Next.js server process"的措辞需要改为泛指"Control Plane（Hono app）"。
- `agent-runtime-protocol.md` 里 `ingestUrl`/`llmProxyUrl`/`controlUrl` 等 URL 示例需要更新为指向 `apps/api` 的域名，不是同域名下的 `/api/*` 路径。
- 部署清单新增：两个独立 Vercel 项目、cookie domain 配置、本地开发 rewrite 配置。
- README.md/CONTRIBUTING.md 的项目结构说明需要在实现该 Phase 时同步更新（不在本轮文档校订范围内，留给实现阶段）。

## ADDED Requirements

### Requirement: Monorepo 结构
项目 SHALL 采用 pnpm workspaces 结构：`apps/web`（Next.js 前端）、`apps/api`（Hono Control Plane）、`packages/shared`（共享 DTO/schema）、`packages/db`（Prisma schema + client）。不引入 Turborepo。

#### Scenario: 依赖隔离
- **WHEN** 检查 `apps/web` 的依赖
- **THEN** 不直接依赖 Prisma client，只能通过 API 访问数据

### Requirement: Auth 挂载于 apps/api
Better Auth SHALL 挂载于 `apps/api`,不挂在 `apps/web`。`apps/web` 通过 HTTP 请求 `apps/api` 完成认证相关操作。

#### Scenario: apps/api 独立管理 session
- **WHEN** 检查 Better Auth 的配置位置
- **THEN** 配置和 session 校验逻辑位于 `apps/api`,不依赖 `apps/web` 的任何模块

### Requirement: 本地开发跨域代理
本地开发环境下,`apps/web` MUST 通过 rewrite 代理将 `/api/*` 请求转发到本地 `apps/api` 端口,使浏览器视角只有一个 origin,避免跨域 cookie 问题。

#### Scenario: 本地代理转发成功
- **WHEN** 本地开发环境下浏览器请求 `apps/web` 的 `/api/health`
- **THEN** 请求被代理到 `apps/api` 并返回其响应,浏览器不感知跨域

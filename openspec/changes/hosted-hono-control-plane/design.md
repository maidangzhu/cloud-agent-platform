# Design — Hosted Hono Control Plane

## Context

ADR-0022 已经规定 `apps/web` 和 `apps/api` 是两个独立 Vercel 项目。当前实现仍有部署配置和验证流程残留旧单应用假设，导致根目录 Next.js 检测、线上 web rewrite、sandbox callback 三条链路相互冲突。

本 change 只定义部署拓扑和 runtime 迁移边界，不直接新建外部资源。新建 API 项目和绑定域名前必须先人工确认。

## Deployment Topology

```text
apps/web
  Vercel project: cloud-agent-platform-web
  Root Directory: apps/web
  Build: @cap/web build
  Runtime config: API_PROXY_TARGET=https://<api-host>

apps/api
  Vercel project: cloud-agent-platform-api
  Root Directory: apps/api
  Runtime: Hono zero-config via default export
  Public health: https://<api-host>/health

repo root
  pnpm workspace only
  not a Vercel app root
```

## Decisions

- App-level Vercel config lives under each deployable app. Root config must not make Vercel treat the repo root as a Next.js project.
- `apps/api/src/index.ts` remains local dev only. Vercel uses `apps/api/src/server.ts` default export importing the shared Hono app.
- `API_PROXY_TARGET` defaults to `http://localhost:8787` for local dev only. Preview/production web must set it to hosted API.
- Hosted API must be verified before web/sandbox workflows are treated as production-ready.
- Pi AI runtime (`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`) is the product runtime. The current self-written loop is transitional and can remain only as deterministic fixture until replacement is complete.

## Risks / Mitigations

- **Root Directory confusion**: Vercel may ignore root workspace context when app root changes. Mitigation: app-level config and explicit build commands, plus preview deploy verification.
- **Secret migration risk**: API project needs DB/Redis/provider/sandbox env. Mitigation: migrate names only through Vercel env, never print values, verify through health/live smoke.
- **Cookie/domain mismatch**: custom domains affect Better Auth URL/cookie domain. Mitigation: confirm domain plan before creating resources.
- **Runtime drift**: self-written loop may continue to grow. Mitigation: track Pi AI replacement as a separate capability and acceptance gate.

## Migration Plan

1. Update docs and OpenSpec.
2. Split Vercel config to app roots.
3. Add Hono zero-config entry for `apps/api`.
4. Confirm API project name/domain with user.
5. Create/deploy API preview and verify `/health`.
6. Point web `API_PROXY_TARGET` at hosted API and deploy web preview.
7. Run live/workflow validation against hosted API.
8. Start Pi AI runtime adapter work.

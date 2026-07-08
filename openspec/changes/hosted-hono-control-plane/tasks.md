# Tasks — Hosted Hono Control Plane

> 每个步骤完成后停下确认。涉及新建 Vercel 项目、绑定域名、迁移 secrets 的步骤必须先人工确认。

## 0. Documentation / Planning

- [x] 0.1 新增 hosted Control Plane 执行计划文档
- [x] 0.2 更新 implementation roadmap，将 Group 21 改为 hosted API 优先
- [x] 0.3 更新 technical design / agent runtime protocol / testing catalog 中的部署和 runtime 边界
- [x] 0.4 新增本 OpenSpec change

## 1. App-level Vercel Config

- [x] 1.1 将根 `vercel.json` 职责迁到 `apps/web/vercel.json`
- [x] 1.2 为 `apps/api` 增加 app-level Vercel 配置
- [x] 1.3 确认根目录不再被 Vercel 作为 Next.js app root 检测
- [x] 1.4 验证 `apps/web` build/typecheck
- [x] 1.5 验证 `apps/api` typecheck/test

## 2. Hono Vercel Runtime

- [x] 2.1 `apps/api` 增加 Hono zero-config entry
- [x] 2.2 新增 `src/server.ts` default export，复用现有 Hono app
- [x] 2.3 保留本地 `tsx watch src/index.ts` dev 入口
- [x] 2.4 本地验证 typecheck/test；preview `/health` 等 API 项目确认后验证

## 3. API Vercel Project

- [ ] 3.1 向用户确认 API 项目名和域名方案
- [ ] 3.2 创建/链接 `apps/api` Vercel 项目，Root Directory=`apps/api`
- [ ] 3.3 迁移 API 需要的环境变量名，不打印 secret 值
- [ ] 3.4 触发 preview deploy 并确认 Ready
- [ ] 3.5 公网验证 `GET /health`
- [ ] 3.6 以 hosted API base URL 跑 live smoke

## 4. Web Project Points To Hosted API

- [ ] 4.1 确认 `apps/web` Root Directory=`apps/web`
- [ ] 4.2 设置 `API_PROXY_TARGET=https://<api-host>`
- [ ] 4.3 触发 web preview deploy 并确认 Ready
- [ ] 4.4 验证 web `/api/health` rewrite 命中 hosted API
- [ ] 4.5 验证登录后首页默认空 composer，首条消息后创建并选中新 thread

## 5. Production-chain Validation

- [ ] 5.1 `pnpm typecheck`
- [ ] 5.2 `pnpm build`
- [ ] 5.3 `pnpm test:integration`
- [ ] 5.4 `pnpm test:workflow`
- [ ] 5.5 `CAP_API_BASE_URL=https://<api-host> pnpm --dir apps/api test:live`
- [ ] 5.6 OpenSpec validate
- [ ] 5.7 隐私扫描：sandbox/runtime env 不含 DB/Auth/长期 provider secrets

## 6. Pi AI Runtime Replacement

- [ ] 6.1 固定 Pi AI runtime（`@earendil-works/pi`）安装、启动、配置方式
- [ ] 6.2 实现 Pi AI ingest/LLM/search/fetch/file/artifact adapter
- [ ] 6.3 在真实 Vercel Sandbox 内启动 Pi AI runtime
- [ ] 6.4 将产品主路径从自写 loop 切换到 Pi AI runtime
- [ ] 6.5 自写 loop 降级为 deterministic fixture 或删除
- [ ] 6.6 workflow/live 验证 Pi AI runtime 通过 hosted API 完成 run

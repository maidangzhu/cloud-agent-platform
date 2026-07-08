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

- [x] 3.1 向用户确认 API 项目名和域名方案（当前使用 `cloud-agent-platform-api` + `api.sandbox.maidang.me`）
- [x] 3.2 创建/链接 `apps/api` Vercel 项目，Root Directory=`apps/api`
- [x] 3.3 迁移 API 需要的环境变量名，不打印 secret 值
- [x] 3.4 触发 preview/prod deploy 并确认 Ready
- [x] 3.5 公网验证 `GET /health`（`https://api.sandbox.maidang.me/health` -> 200）
- [x] 3.6 以 hosted API base URL 跑 live smoke（`CAP_API_BASE_URL=https://api.sandbox.maidang.me pnpm --dir apps/api test:live`）

## 4. Web Project Points To Hosted API

- [x] 4.1 确认 `apps/web` Root Directory=`apps/web`
- [x] 4.2 设置 `API_PROXY_TARGET=https://api.sandbox.maidang.me`
- [x] 4.3 触发 web preview/prod deploy 并确认 Ready
- [x] 4.4 验证 web `/api/health` rewrite 命中 hosted API（`https://sandbox.maidang.me/api/health` -> 200）
- [x] 4.5 验证登录后首页默认空 composer，首条消息后创建并选中新 thread（`@cap/web` typecheck/build 通过；本地 web 指向 hosted API 浏览器验收通过）

## 5. Production-chain Validation

- [x] 5.1 `pnpm typecheck`
- [x] 5.2 `pnpm build`
- [x] 5.3 `pnpm test:integration`
- [x] 5.4 `pnpm test:workflow`
- [x] 5.5 `CAP_API_BASE_URL=https://api.sandbox.maidang.me pnpm --dir apps/api test:live`
- [ ] 5.6 OpenSpec validate（2026-07-08：`hosted-hono-control-plane` / `v2-research-workspace-agent` valid；全量 validate 仍被既有 `agent-eval-monitoring` 空 delta 阻塞）
- [x] 5.7 隐私扫描：sandbox/runtime env 不含 DB/Auth/长期 provider secrets

## 6. Pi AI Runtime Replacement

- [x] 6.1 固定 Pi AI runtime（`@earendil-works/pi-agent-core@0.80.3` + `@earendil-works/pi-ai@0.80.3`）安装、启动、配置方式（新增 `apps/api/src/pi-runtime/*` 启动协议与 Agent shell；`@cap/api` pi-runtime test/typecheck 通过）
- [x] 6.2 实现 Pi AI ingest/LLM/search/fetch/file/artifact adapter（新增 `apps/api/src/pi-runtime/control-plane-client.ts`、`adapters.ts`、`adapters.test.ts`；覆盖 scoped token 请求、LLM proxy stream 包装、search/fetch/file/artifact tool adapter；`@cap/api` pi-runtime test/typecheck 通过）
- [x] 6.3 在真实 Vercel Sandbox 内启动 Pi AI runtime（新增 sandbox 注入/执行函数和 Pi runtime workflow smoke；使用 hosted API base 回调 heartbeat/LLM proxy；`CAP_API_BASE_URL=https://api.sandbox.maidang.me pnpm --filter @cap/api test:workflow -- src/pi-runtime/pi-runtime.workflow.test.ts` 通过）
- [x] 6.4 将产品主路径从自写 loop 切换到 Pi AI runtime（`run/orchestrator.ts` 改为 `runPiRuntimeInSandbox`；Pi sandbox script 执行 LLM proxy/tool loop，并通过 ingest 写 run events/tool calls/files/artifacts；真实 hosted workflow 通过）
- [x] 6.5 自写 loop 降级为 deterministic fixture 或删除（产品 orchestrator 不再引用 `runAgentLoopScriptInSandbox`；旧 loop 仅保留给 deterministic workflow/fixture 测试）
- [x] 6.6 workflow/live 验证 Pi AI runtime 通过 hosted API 完成 run（部署新版 API 后，`test:live` 通过；`pi-runtime.workflow.test.ts` 验证真实 sandbox 内 Pi runtime 通过 hosted API 写 run events/tool calls/files/artifacts；auto-start workflow 验证产品创建 run 后自动走 Pi runtime；sandbox stdout 断言 `forbiddenEnvPresent:false`）
- [x] 6.7 LLM Proxy 在 hosted Control Plane 边界将 Pi-style tools 归一成 OpenAI function tools，并修正 `write_file` 不提前 terminate、`create_artifact` 后 terminate、artifact kind 必须是 `text|code|sheet|image`，已写文件但未产出 artifact 时由 sandbox 走同一 ingest/tool-call 路径补建 artifact（provider + pi-runtime test、`@cap/api` typecheck 通过）
- [x] 6.8 部署新版 API 后跑公网 production E2E，确认真实 provider/Pi runtime artifact fallback 触发 tools，且 files/artifacts 通过 hosted API 可读（`CAP_API_BASE_URL=https://api.sandbox.maidang.me pnpm --dir apps/api test:live`：7/7 passed，2026-07-08）

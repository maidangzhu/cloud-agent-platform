> 与 `docs/implementation-roadmap.md` 的 21 个 Group / 45 个 Step 一一对应，任务描述保持简短，具体的代码任务/测试断言/验收标准/所需 env 变量见该文档对应章节链接。规矩：每个任务做完必须停下来等用户确认，不允许连续勾选多个任务不停顿。

## 0. PoC（环境连通性）

- [x] 0.1 验证 Upstash Redis 连通性（SET/GET、XADD/XREAD、cursor 续读）— `scripts/poc/redis-ping.ts`
- [x] 0.2 验证 v2 分支下 Vercel Sandbox 封装可用 — `scripts/poc/sandbox-ping.ts`

## 1. 文档校订（ADR-0018~0022）

- [x] 1.1 补 ADR-0018（状态变更统一走条件原子 UPDATE）
- [x] 1.2 补 ADR-0019（新增 waiting_for_input 状态，解决 DQ-1）
- [x] 1.3 补 ADR-0020（AgentEventDTO.payload schema + 工具失败重试协议，解决 DQ-3）
- [x] 1.4 补 ADR-0021（Token 转发改 Redis Streams + cursor，修正 ADR-0016）
- [x] 1.5 补 ADR-0022（后端采用 Hono，项目重构为 monorepo）
- [x] 1.6 修订 state-machines.md / agent-runtime-protocol.md / api-contract.md / design-system.md / data-model.md / backend-domain-model.md / glossary.md / frontend-vercel-chatbot-reference.md
- [x] 1.7 testing-strategy.md §4 从提纲改写为约 260+ 条具体测试名清单
- [x] 1.8 新建 docs/implementation-roadmap.md（21 Group / 45 Step 执行路线图）
- [x] 1.9 归档 v1 openspec change（cloud-agent-platform-mvp），新建 v2 change 并补齐 proposal/design/specs

## 2. Monorepo 脚手架（ADR-0022）

- [x] 2.1 建 pnpm workspace 空壳（pnpm-workspace.yaml + apps/web + apps/api + packages/shared + packages/db 四个空壳 package），验证不破坏现有 pnpm test/build
- [x] 2.2 起最小 Hono app（GET /health），本地 dev 验证 + 路由测试
- [x] 2.3 迁移 Prisma 到 packages/db（新建副本方案，用户确认；根目录 prisma/ 原样保留待 Group 3 收尾）
- [x] 2.4 本地开发跨域 cookie 代理（next.config.ts rewrite /api/health 到本地 Hono 端口，验证过）

## 3. Auth（Better Auth 挂 apps/api）

- [x] 3.1 装 Better Auth，接入 Hono，生成 schema tables（真实 Neon 集成测试 7 条通过，含 2 处踩坑修复：modelName 大小写、schema 生成路径隔离）
- [x] 3.2 `GET /api/me` + 受保护路由 helper（requireUser，真实 Neon 集成测试 3 条通过 + 手动 curl 全流程验证）

## 4. Workspace

- [x] 4.1 Workspace 数据模型 + CRUD 路由（含 title 校验、archive 策略；踩坑：v1 Workspace model 97 条真实数据命名冲突，已安全重命名为 SandboxInstance；踩坑：根 tsconfig 未排除 monorepo 子包）
- [x] 4.2 Workspace 归档的原子拒绝（insert-select，ADR-0018；提前建最小 Thread 表验证，真实并发集成测试 3 条通过）

## 5. Thread

- [x] 5.1 Thread 数据模型 + CRUD 路由（含 title 派生逻辑；踩坑：v2 Message model 与 v1 遗留 Message model 撞名共享同一张 301 行生产表，改名为 ThreadMessage 规避）

## 6. Run 状态机 + Event Store（ADR-0018/0019 核心落地）

- [x] 6.1 RunStatus 纯函数状态机（isLegalTransition + deriveUiState，不接数据库）
- [x] 6.2 transitionRun 原子 UPDATE 封装（真实并发集成测试通过；踩坑：v2 Run model 与 v1 遗留 Run model 撞名，183 行生产数据 + 14 处活代码依赖，改名为 AgentRun 规避）
- [x] 6.3 Run + AgentEvent 数据模型 + 创建/查询/取消路由（含 waiting_for_input 收尾逻辑；踩坑：v2 AgentEvent/ToolCall 与 v1 同名 model 撞名，改名为 RunEvent/RunToolCall 规避；用户明确表示 v1 旧数据不重要，此后撞名不再需要先证明数据量，直接换名或清空 v1 表即可）
- [x] 6.4 Event Store（seq 唯一性、幂等、payload schema 校验）
- [x] 6.5 SSE 基础（snapshot + 推送 + done，暂不接 stream-chunk）

## 7. Scoped Run Token

- [x] 7.1 Token 签发与校验（绑定 user/workspace/thread/run + 过期）

## 8. Ingest API 基线

- [x] 8.1 POST /api/ingest/events + heartbeat（真实 HTTP 端点，接 Group 7 token）
- [x] 8.2 POST /api/ingest/tool-calls（含 rejected/failed 区分）

## 9. Fake Sandbox Runner

- [x] 9.1 Scripted ingest fixture（本地脚本模拟，只走 ingest HTTP，不碰数据库）
- [x] 9.2 接入真实 Vercel Sandbox（scripted runner 跑在真沙箱里，验证 currentRunId 复用互斥）

## 10. Workspace Files

- [x] 10.1 File ingest + 查询路由（path guard、content hash、size policy）
- [x] 10.2 Scripted runner 写文件端到端验证

## 11. Artifacts

- [x] 11.1 Artifact ingest + 首次创建（version=1）
- [x] 11.2 Artifact 版本化（artifact_updated）+ versions/download 端点

## 12. Sources

- [x] 12.1 Source ingest + 查询（含 artifact 引用关系）

## 13. Token Stream 转发（ADR-0021）

- [x] 13.1 正式的 Redis 客户端封装 + POST /api/ingest/stream-chunk
- [x] 13.2 SSE 端接入 cursor 续读（Last-Event-ID）
- [x] 13.3 过期 stream 清理（接入 Group 18 sweep）

## 14. LLM Proxy

- [x] 14.1 LLM Proxy 路由 + fake provider
- [x] 14.2 真实 provider 接入 + finish_reason 归一化
- [x] 14.3 Usage 记录（LLMUsageRecord）

## 15. Search Proxy + 工具协议（ADR-0020，解决 DQ-3）

- [x] 15.1 Search Proxy 路由（fake provider + 重试逻辑）
- [x] 15.2 真实 search provider 接入
- [x] 15.3 fetch_url 工具（SSRF guard + 重试）
- [x] 15.4 web_search 工具（走 search proxy）

## 16. 真实 Sandbox Agent Loop

- [x] 16.1 Agent loop 骨架（非流式，fake LLM 驱动跑通基本循环）
- [x] 16.2 接入流式 + token 攒批（ADR-0017）+ Redis 转发（ADR-0021）
- [x] 16.3 waiting_for_input 完整链路（ADR-0019 端到端）
- [x] 16.4 cancel + timeout 收敛

## 17. Usage 遥测

- [x] 17.1 GET /api/usage/records 查询端点（分页 + 过滤）

## 18. Sweep

- [x] 18.1 Sweep 核心逻辑（run 收敛，含 stale created 收敛）
- [x] 18.2 waiting_for_input 阈值兜底（7 天）
- [x] 18.3 孤儿资源清理（SandboxInstance + Redis stream）
- [x] 18.4 接入 Vercel Cron

## 19. UI Shell

- [x] 19.1 App Shell 骨架（Next App Router shell、tokens/theme、三栏/移动端响应式）
- [x] 19.2 Sidebar 数据流（auth、workspace/thread snapshot、create workspace/thread）
- [x] 19.3 Conversation + Composer 主体（thread snapshot、run create/cancel、sticky composer）
- [x] 19.4 Run Timeline + SSE（snapshot、stream_chunk、event type、done、ping、去重）
- [x] 19.5 Artifact Preview / Panel（preview、desktop panel、mobile full-screen、actions/version footer）
- [ ] 19.6 抽出共享 `useComposerEnabled` hook，对齐 frontend-shell spec 的 composer enabled 规则
- [x] 19.7 浏览器 SSE 主路径改为 `POST /api/runs/:runId/events`（GET 保留兼容，body `lastEventId` 支持续读）
- [x] 19.8 `POST /api/threads/:threadId/runs` 创建 run 后自动调度真实 Vercel Sandbox runner（签 scoped token、claim sandbox、启动 agent-loop、通过 ingest 回写事件）

## 20. Browser E2E

- [ ] 20.1 到达该 Group 时展开具体子步骤（login → workspace → thread → run → waiting_for_input → Stage2 → artifact → cancel）

## 21. 部署和运维

- [x] 21.1 根目录退出 Vercel app root；部署配置下沉到 `apps/web` / `apps/api`
- [x] 21.2 `apps/api` 增加 Hono zero-config Vercel entry，保留本地 node-server dev 入口
- [x] 21.3 向用户确认 API Vercel 项目名和域名方案（当前使用 `cloud-agent-platform-api` + `api.sandbox.maidang.me`）
- [x] 21.4 创建/链接独立 `apps/api` Vercel 项目，Root Directory=`apps/api`，迁移 API env 名
- [x] 21.5 部署并验证 hosted API Ready：公网 `/health` 200，live smoke 可打 `CAP_API_BASE_URL`
- [x] 21.6 `apps/web` Root Directory=`apps/web`，`API_PROXY_TARGET` 指向 hosted API，验证 web Ready
- [x] 21.7 修复并验证首页默认空 composer：登录后不自动选中历史 thread，首条消息后才创建/选中新 thread（`@cap/web` typecheck/build 通过；本地 web 指向 hosted API 浏览器验收通过）
- [ ] 21.8 跑完整验证清单：typecheck / build / integration / workflow / live / openspec validate / 隐私扫描（2026-07-08：typecheck/build/integration/workflow/live/隐私扫描通过，相关 changes valid；全量 validate 仍被既有 `agent-eval-monitoring` 空 delta 阻塞）

## 22. Pi AI Agent Runtime 替换

- [x] 22.1 固定 Pi AI runtime（`@earendil-works/pi-agent-core@0.80.3` + `@earendil-works/pi-ai@0.80.3`）安装、启动、配置和 tool adapter 方式（新增 `apps/api/src/pi-runtime/*` 启动协议与 Agent shell；`@cap/api` pi-runtime test/typecheck 通过）
- [x] 22.2 实现 Pi AI ingest / LLM proxy / search / fetch / file / artifact adapter（新增 `control-plane-client.ts`、`adapters.ts`、`adapters.test.ts`；覆盖 scoped token 请求、LLM proxy stream 包装、search/fetch/file/artifact tool adapter；`pnpm --filter @cap/api test -- src/pi-runtime` 与 `pnpm --filter @cap/api typecheck` 通过）
- [x] 22.3 在真实 Vercel Sandbox 内启动 Pi AI runtime，使用 hosted API base URL 回调（新增 `PI_RUNTIME_SANDBOX_SCRIPT`、`installPiRuntimeInSandbox`、`runPiRuntimeInSandbox`、真实 workflow smoke；`CAP_API_BASE_URL=https://api.sandbox.maidang.me pnpm --filter @cap/api test:workflow -- src/pi-runtime/pi-runtime.workflow.test.ts` 通过）
- [x] 22.4 将产品主路径从自写 `apps/api/src/agent-loop/*` 切换到 Pi AI runtime（`run/orchestrator.ts` 改为 `runPiRuntimeInSandbox`；Pi sandbox script 执行 LLM proxy/tool loop，并通过 ingest 写 `RunEvent`、`RunToolCall`、`WorkspaceFile`、`WorkspaceArtifact`；真实 hosted workflow 通过）
- [x] 22.5 自写 loop 降级为 deterministic fixture 或删除（产品 orchestrator 不再引用 `runAgentLoopScriptInSandbox`；旧 loop 仅保留给 deterministic workflow/fixture 测试）
- [x] 22.6 workflow/live 验证 Pi AI runtime 完成 run，且 sandbox env 不含 DB/Auth/长期 provider secrets（部署新版 API 后，`test:live` 通过；`pi-runtime.workflow.test.ts` 验证真实 sandbox 内 Pi runtime 通过 hosted API 写 run events/tool calls/files/artifacts；auto-start workflow 验证产品创建 run 后自动走 Pi runtime；sandbox stdout 断言 `forbiddenEnvPresent:false`）
- [x] 22.7 LLM Proxy 防腐层将 Pi-style tools 归一成 OpenAI function tools，`write_file` 成功后立即通过 ingest 提升 artifact 并 terminate，后续同批 `create_artifact` 幂等跳过重复 ingest，artifact kind 收窄到 `text|code|sheet|image`，避免真实 provider 只写文件后 loop 不收敛（`@cap/api` provider + pi-runtime test、typecheck 通过）
- [x] 22.8 部署新版 API 后跑公网 production E2E：`https://api.sandbox.maidang.me` 创建 run → 真实 Vercel Sandbox 内 Pi runtime → 真实 provider tool calls/runtime artifact fallback → ingest 写 `RunEvent`/`RunToolCall`/`WorkspaceFile`/`WorkspaceArtifact`，并从公网 API 读回验证（`CAP_API_BASE_URL=https://api.sandbox.maidang.me pnpm --dir apps/api test:live`：7/7 passed，2026-07-08）
- [x] 22.9 补齐 Pi runtime sandbox 基础工具面：`read_file`、`write_file`、`list_directory`/`list_files`、`run_command`；`write_file` 同步写 sandbox 磁盘和 hosted ingest，`run_command` 在 workspace cwd 内执行 bash 并带 denylist、timeout、输出截断，不注入 DB/Auth/provider secrets

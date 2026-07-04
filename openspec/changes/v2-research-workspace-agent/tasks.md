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
- [ ] 2.3 迁移 Prisma 到 packages/db（含用户确认迁移后原 prisma/ 目录如何处理）
- [ ] 2.4 apps/web 本地开发跨域 cookie 代理（rewrite /api/* 到本地 Hono 端口）

## 3. Auth（Better Auth 挂 apps/api）

- [ ] 3.1 装 Better Auth，接入 Hono，生成 schema tables
- [ ] 3.2 `GET /api/me` + 受保护路由 helper（requireUser）

## 4. Workspace

- [ ] 4.1 Workspace 数据模型 + CRUD 路由（含 title 校验、archive 策略）
- [ ] 4.2 Workspace 归档的原子拒绝（insert-select，ADR-0018）

## 5. Thread

- [ ] 5.1 Thread 数据模型 + CRUD 路由（含 title 派生逻辑）

## 6. Run 状态机 + Event Store（ADR-0018/0019 核心落地）

- [ ] 6.1 RunStatus 纯函数状态机（isLegalTransition + deriveUiState，不接数据库）
- [ ] 6.2 transitionRun 原子 UPDATE 封装
- [ ] 6.3 Run + AgentEvent 数据模型 + 创建/查询/取消路由（含 waiting_for_input 收尾逻辑）
- [ ] 6.4 Event Store（seq 唯一性、幂等、payload schema 校验）
- [ ] 6.5 SSE 基础（snapshot + 推送 + done，暂不接 stream-chunk）

## 7. Scoped Run Token

- [ ] 7.1 Token 签发与校验（绑定 user/workspace/thread/run + 过期）

## 8. Ingest API 基线

- [ ] 8.1 POST /api/ingest/events + heartbeat（真实 HTTP 端点，接 Group 7 token）
- [ ] 8.2 POST /api/ingest/tool-calls（含 rejected/failed 区分）

## 9. Fake Sandbox Runner

- [ ] 9.1 Fake runner 骨架（本地进程模拟，只走 ingest HTTP，不碰数据库）
- [ ] 9.2 接入真实 Vercel Sandbox（fake runner 跑在真沙箱里，验证 currentRunId 复用互斥）

## 10. Workspace Files

- [ ] 10.1 File ingest + 查询路由（path guard、content hash、size policy）
- [ ] 10.2 Fake runner 写文件端到端验证

## 11. Artifacts

- [ ] 11.1 Artifact ingest + 首次创建（version=1）
- [ ] 11.2 Artifact 版本化（artifact_updated）+ versions/download 端点

## 12. Sources

- [ ] 12.1 Source ingest + 查询（含 artifact 引用关系）

## 13. Token Stream 转发（ADR-0021）

- [ ] 13.1 正式的 Redis 客户端封装 + POST /api/ingest/stream-chunk
- [ ] 13.2 SSE 端接入 cursor 续读（Last-Event-ID）
- [ ] 13.3 过期 stream 清理（占位函数，接入 Group 18 sweep）

## 14. LLM Proxy

- [ ] 14.1 LLM Proxy 路由 + fake provider
- [ ] 14.2 真实 provider 接入 + finish_reason 归一化
- [ ] 14.3 Usage 记录（LLMUsageRecord）

## 15. Search Proxy + 工具协议（ADR-0020，解决 DQ-3）

- [ ] 15.1 Search Proxy 路由（fake provider + 重试逻辑）
- [ ] 15.2 真实 search provider 接入
- [ ] 15.3 fetch_url 工具（SSRF guard + 重试）
- [ ] 15.4 web_search 工具（走 search proxy）

## 16. 真实 Sandbox Agent Loop

- [ ] 16.1 Agent loop 骨架（非流式，fake LLM 驱动跑通基本循环）
- [ ] 16.2 接入流式 + token 攒批（ADR-0017）+ Redis 转发（ADR-0021）
- [ ] 16.3 waiting_for_input 完整链路（ADR-0019 端到端）
- [ ] 16.4 cancel + timeout 收敛

## 17. Usage 遥测

- [ ] 17.1 GET /api/usage/records 查询端点（分页 + 过滤）

## 18. Sweep

- [ ] 18.1 Sweep 核心逻辑（run 收敛）
- [ ] 18.2 waiting_for_input 阈值兜底（7 天）
- [ ] 18.3 孤儿资源清理（SandboxInstance + Redis stream）
- [ ] 18.4 接入 Vercel Cron

## 19. UI Shell

- [ ] 19.1 到达该 Group 时展开具体子步骤（App Shell → Sidebar → Conversation/Composer → Run Timeline → Artifact Preview/Panel）

## 20. Browser E2E

- [ ] 20.1 到达该 Group 时展开具体子步骤（login → workspace → thread → run → waiting_for_input → Stage2 → artifact → cancel）

## 21. 部署和运维

- [ ] 21.1 到达该 Group 时展开具体子步骤（两个独立 Vercel 项目、cookie domain、secrets、日志可观测性）

## Why

v1（`cloud-agent-platform-mvp`，已归档于 `openspec/changes/archive/2026-07-04-cloud-agent-platform-mvp/`）验证了 agent-in-sandbox 的端到端主链路，但产品定位、执行模型、数据模型均已被后续架构拷问推翻：`Session` 改为 `Thread`、`provisioning_workspace` 状态机改为更完整的 Run 状态机（含 `waiting_for_input`）、单次报告生成改为"机制级深挖"两阶段交互、credit 强制执行改为用量遥测、后端从 Next.js API routes 迁移到独立 Hono 服务的 monorepo 架构。这些决策已在 `docs/decisions/`（ADR-0001~0022）逐条论证并写入 `docs/api-contract.md`、`docs/data-model.md`、`docs/state-machines.md`、`docs/testing-strategy.md`、`docs/implementation-roadmap.md`，但从未落回 OpenSpec——导致"进度用 OpenSpec 记录"这条团队约定（见 CONTRIBUTING.md）在 v2 阶段被绕开。

本变更把这批已经拍板的架构决策转译为 OpenSpec 的 capabilities + specs + tasks，让 v2 的实现推进重新回到可用 `openspec status` 追踪的轨道上，同时不重复内容：`docs/decisions/` 保留作为决策论证的详细记录（为什么这么定、被否方案是什么），OpenSpec 的 spec.md 只承载"系统应该做什么"的可测试 Requirement/Scenario，tasks.md 对应 `docs/implementation-roadmap.md` 的 21 个 Group/45 个 Step 逐步执行计划。

## What Changes

- **BREAKING**：废弃 v1 的 `Session`/`provisioning_workspace` 状态机模型，替换为 `Thread`/完整 Run 状态机（含 `waiting_for_input`，ADR-0019）。
- **BREAKING**：废弃 v1 的 credit reserve/debit/refund 强制执行模型，替换为纯观测的 `LLMUsageRecord`（ADR-0015）。
- **BREAKING**：后端从 Next.js API routes（`src/app/api/*`）迁移到独立 Hono 服务（`apps/api`），项目重构为 pnpm workspaces monorepo（`apps/web` + `apps/api` + `packages/shared` + `packages/db`，ADR-0022）。
- 新增所有状态变更统一走条件原子 UPDATE（`transitionRun`），禁止 check-then-act（ADR-0018）。
- 新增 `AgentEventDTO.payload` 判别联合 schema，按事件类型定义具体字段形状（ADR-0020）。
- 新增 token 转发通道：Redis Streams + cursor（`POST /api/ingest/stream-chunk`），修正此前的 Pub/Sub 方案会丢失建连竞态和重连期间消息的问题（ADR-0021，修正 ADR-0016）。
- 新增 `POST /api/search-proxy` 端点及 `web_search`/`fetch_url` 工具的失败重试协议（ADR-0020，解决 DQ-3）。
- 新增 Artifact 版本化规则：`artifactId` 已存在时产生 `artifact_updated` 事件而非 `artifact_created`（ADR-0020）。
- 新增 sweep 职责范围扩大到清理孤儿沙箱和过期 Redis stream key（ADR-0015/0021）。

## Capabilities

### New Capabilities

- `workspace-management`：Workspace CRUD、归档策略、所有权边界（授权收敛点）。
- `thread-management`：Thread CRUD、Message 持久化、标题派生。
- `run-lifecycle`：Run 状态机（含 `waiting_for_input`）、条件原子 UPDATE（`transitionRun`）、derived UI state 推导、取消协议。
- `event-ingest`：AgentEvent append-only 存储、seq 单调性、幂等/冲突判定、payload 判别联合 schema 校验、SSE snapshot/推送。
- `scoped-run-token`：Run 绑定的短期凭证签发与校验，跨 run/workspace 隔离。
- `sandbox-orchestration`：SandboxInstance 生命周期、warm/ready 复用互斥（`currentRunId` 原子认领）、fake runner 测试基础设施。
- `workspace-files`：WorkspaceFile ingest、path guard、内容存储策略。
- `artifact-management`：Artifact 创建/版本化（`artifact_created`/`artifact_updated`）、版本历史、下载。
- `source-tracking`：Source 记录与 artifact 引用关系。
- `token-stream-relay`：Redis Streams token 转发通道，cursor/Last-Event-ID 续读语义。
- `llm-proxy`：LLM 代理端点、provider 凭证托管、finish_reason 归一化、用量记录。
- `search-proxy-and-tools`：Search 代理端点、`web_search`/`fetch_url` 工具协议（SSRF guard、重试策略）。
- `usage-telemetry`：LLMUsageRecord 查询端点（原 credit ledger，改为纯观测）。
- `sweep-safety-net`：定时收敛非终态 run、清理孤儿沙箱与过期 stream key。
- `monorepo-hono-backend`：pnpm workspaces 结构、Hono Control Plane、Better Auth 挂载位置、本地开发跨域代理。
- `frontend-shell`：Workspace/Thread/Run/Artifact 的前端信息架构、composer 状态规则（`useComposerEnabled`）、artifact panel。

### Modified Capabilities

<!-- openspec/specs/ 当前为空（v1 archive 时选择 --skip-specs，未合并旧 spec），因此本变更没有需要 delta 的既有 capability，全部按 New Capabilities 处理。 -->

## Impact

- 受影响代码：`src/app/api/*`、`src/server/*` 全部迁移到 `apps/api`；`prisma/schema.prisma` 迁移到 `packages/db`。
- 新增依赖：`hono`、`@hono/node-server`、`@hono/vercel`、`ioredis`（已装 5.11.1）、`better-auth`。
- 新增外部服务依赖：Redis（Upstash，已通过 PoC 验证连通性，见 `scripts/poc/redis-ping.ts`）。
- 数据模型变更：`RunStatus` 新增 `waiting_for_input`；`SandboxInstance` 新增 `currentRunId`；`CreditLedger`/`CreditBalance` 废弃替换为 `LLMUsageRecord`。
- 详细决策论证见 `docs/decisions/`（ADR-0001~0022）；接口契约见 `docs/api-contract.md`；测试断言清单见 `docs/testing-strategy.md`；逐步执行计划见 `docs/implementation-roadmap.md`（本提案的 tasks.md 与其一一对应）。

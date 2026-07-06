# 后端领域模型

这份文档定义后端领域对象、所有权、关系、不变量和服务边界。

它是实现和测试时使用的后端“世界观”。

## 1. 领域概览

```text
User
  owns many Workspaces

Workspace
  has many Threads
  has many Runs
  has many WorkspaceFiles
  has many Artifacts
  has many Sources
  has one active-or-latest SandboxInstance

Thread
  belongs to Workspace
  has many Messages
  has many Runs

Run
  belongs to User, Workspace, Thread
  has many AgentEvents
  has many ToolCalls
  may create WorkspaceFiles
  may create Artifacts
  may record Sources
  may produce LLMUsageRecord entries（用量遥测，见 ADR-0015）

SandboxRunner
  executes one Run
  reports facts through Ingest API
```

## 2. 所有权规则

### User Ownership

User 拥有：

- `ownerUserId = user.id` 的 workspaces
- 自己 workspace 下的 threads
- 自己 workspace 下的 runs
- 自己 workspace 下的 files
- 自己 workspace 下的 artifacts
- 自己 workspace 下的 sources
- 自己 workspace 下 run 产生的 `LLMUsageRecord`（用量遥测，见 [ADR-0015](./decisions/0015-usage-telemetry-and-ops-priorities.md)）

P0 不做多人协作。因此，所有访问控制都可以收敛为 workspace ownership 检查。

### Workspace Boundary

Workspace 是主要授权边界。

Workspace 下的业务表都必须带 `workspaceId`：

- Thread
- Message
- Run
- AgentEvent
- ToolCall
- WorkspaceFile
- Artifact
- Source
- SandboxInstance

原因：

- 权限判断更简单
- scoped query 更快
- 数据导出/删除更容易
- 更能约束 AI 生成代码

## 3. 聚合根

### Workspace Aggregate

Root：

- Workspace

Children：

- Thread
- Message
- Run
- AgentEvent
- ToolCall
- WorkspaceFile
- Artifact
- Source
- SandboxInstance

允许操作：

- create workspace
- update title
- archive workspace
- list threads
- list files
- list artifacts
- list sources

不变量：

- archived workspace 不能启动新 run。
- 用户不能访问其他用户的 workspace。
- 删除/归档 workspace 前必须先定义 child behavior。

### Run Aggregate

Root：

- Run

Children：

- AgentEvent
- ToolCall
- created files
- created artifacts
- recorded sources
- related LLMUsageRecord entries

允许操作：

- create run
- provision sandbox（认领 SandboxInstance 必须走条件原子 UPDATE，见 [ADR-0018](./decisions/0018-atomic-state-transitions.md)）
- transition status（统一通过 `transitionRun`，禁止 check-then-act，见 [ADR-0018](./decisions/0018-atomic-state-transitions.md)）
- append event
- record tool call
- ingest file
- ingest artifact
- ingest source
- cancel run
- finalize run（含转入 `waiting_for_input`，见 [ADR-0019](./decisions/0019-waiting-for-input-state.md)）

不变量：

- run 属于一个 thread。
- run 属于一个 workspace。
- run 属于一个 user。
- 终态 run status 不可覆盖；所有状态转移必须通过条件原子 UPDATE（[ADR-0018](./decisions/0018-atomic-state-transitions.md)），不允许 check-then-act。
- event seq 在同一个 run 内唯一。
- ingest token 必须匹配 run 绑定关系。

### Usage Aggregate（原 Credit Aggregate，[ADR-0015](./decisions/0015-usage-telemetry-and-ops-priorities.md) 改为用量遥测）

Root：

- LLMUsageRecord

允许操作：

- record（每次 LLM proxy / search proxy 调用后写入一条）

不变量：

- append-only。
- 纯观测记录，不产生"拒绝执行"的业务后果——没有 reserve/debit/refund，没有 balance 概念，没有"额度不足拒绝启动 run"这类路径。

## 4. 服务边界

### Auth Service

挂在 `apps/api`（Hono Control Plane，见 [ADR-0022](./decisions/0022-monorepo-hono-backend.md)），不是 `apps/web`。

职责：

- Better Auth integration
- current user resolution
- protected route helper

不负责：

- 除返回当前用户外的 workspace 授权逻辑
- 业务 session/thread

### Workspace Service

职责：

- workspace CRUD
- workspace ownership checks
- workspace list
- archive/delete policy

### Thread Service

职责：

- thread CRUD
- message read/write
- title derivation
- thread snapshot DTO

### Run Service

职责：

- run creation
- run state transitions
- cancellation
- derived UI state
- run DTO

不负责：

- sandbox provider 实现细节
- LLM provider 细节
- 用量计价内部逻辑（不存在"计价拒绝"这层逻辑，见 ADR-0015）

### Event Store

职责：

- append events
- enforce seq uniqueness
- reject illegal terminal-state events
- convert events to DTO

### Sandbox Orchestrator

职责：

- create/resume sandbox
- write/start sandbox runner
- pass run config
- store sandbox instance metadata

不负责：

- 在 Control Plane 内执行 agent loop

### Ingest Service

职责：

- verify scoped run token
- validate payloads
- persist events/tool calls/files/artifacts/sources
- update heartbeat
- enforce run status rules

### LLM Proxy Service

职责：

- verify scoped run token
- check run status
- call configured LLM provider
- record usage（写入 LLMUsageRecord，见 ADR-0015）
- return or stream response to sandbox
- 归一化 `finish_reason` 等语义边界信号（[ADR-0009](./decisions/0009-provider-anti-corruption-layer.md)/[ADR-0017](./decisions/0017-token-accumulation-and-persistence-timing.md)）

### Search Proxy Service（新增，[ADR-0020](./decisions/0020-agent-event-payload-schema-and-tool-retry.md)）

职责：

- verify scoped run token
- check run status
- 持有 search provider key（如 Exa），调用真实 search API
- 失败重试（5xx 重试 2 次，4xx 不重试）
- record usage
- 返回归一化结果列表

### Usage Service（原 Credit Service，[ADR-0015](./decisions/0015-usage-telemetry-and-ops-priorities.md)）

职责：

- 记录每次 LLM proxy / search proxy 调用产生的 LLMUsageRecord
- 按 runId/provider/model 查询用量

不负责：

- reserve/debit/refund（不存在这套机制）
- 判断"额度是否足够"（不存在这个判断）

## 5. 领域不变量

全局不变量：

- Sandbox 没有 DB 凭证。
- Sandbox 没有 Better Auth session。
- Agent loop 在 sandbox 内运行。
- Control Plane 是持久化事实源（[ADR-0022](./decisions/0022-monorepo-hono-backend.md)：物理上是 `apps/api`，Hono app）。
- Workspace 是授权边界。
- Thread 不是 auth session。
- Artifact 不是 workspace file。
- Assistant message 不是 artifact。
- LLMUsageRecord 是用量事实源（不是点数/余额事实源，见 ADR-0015）。
- 所有状态变更走条件原子 UPDATE，禁止 check-then-act（[ADR-0018](./decisions/0018-atomic-state-transitions.md)）。

Run 不变量：

- `Run.workspaceId` 必须等于 `Thread.workspaceId`。
- P0 下 `Run.userId` 必须等于 `Workspace.ownerUserId`。
- `AgentEvent.workspaceId` 必须等于 `Run.workspaceId`。
- `ToolCall.workspaceId` 必须等于 `Run.workspaceId`。
- 终态 run 不允许继续接收普通新事件；`waiting_for_input` 同样不接收普通新事件（[ADR-0019](./decisions/0019-waiting-for-input-state.md)）。

Artifact 不变量：

- Artifact 属于 workspace。
- Artifact 必须有 `runId`。
- Artifact 必须有 `title`、`kind` 和可恢复内容引用。
- Artifact 可以引用 workspace file path，但不能只依赖可变的当前文件内容。

File 不变量：

- Workspace file path 必须规范化。
- Workspace file path 不能逃逸 workspace root。
- Workspace file metadata 必须包含 hash 和 size。

Usage 不变量（原 Credit 不变量，[ADR-0015](./decisions/0015-usage-telemetry-and-ops-priorities.md)）：

- 用量记录不影响 run 是否能启动——没有"额度不足拒绝"这条路径。
- LLMUsageRecord 是 append-only，不需要幂等去重（重复调用产生多条记录是预期行为，不是 bug）。

## 6. P0 非目标

P0 不实现：

- 多人 workspace 协作
- 组织/团队
- owner 访问以外的 RBAC
- artifact 富文本手动编辑
- 完整文件版本历史
- 长期语义记忆
- 外部账号集成
- 自动创建 PR

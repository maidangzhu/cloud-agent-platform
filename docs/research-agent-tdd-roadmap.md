# Research Workspace Agent — TDD 路线图

## 1. 目标

构建一个通用 research agent 平台，核心是持久化 workspace。

平台必须支持：

- 用户注册和登录
- 点数计费
- 每个用户多个 workspaces
- 每个 workspace 下多个 threads
- agent loop 在 sandbox 内运行
- sandbox agent 创建和更新 workspace files
- artifact 作为正式交付物
- event streaming，并能从数据库 snapshot 恢复
- API-first 开发：所有 workflow 必须先用 API 和测试闭环，再做 UI

产品不是普通聊天机器人，而是一个研究工作区。Agent 可以搜索、抓取、阅读、写文件、运行命令、保留中间文件、记录 sources，并生成 artifacts。

## 2. 核心架构

```text
Browser
  |
  | Better Auth cookie
  v
Control Plane (Next.js)
  |
  | owns auth, workspace metadata, run state, credits, API, SSE
  | owns DB credentials, sandbox provider credentials, LLM credentials
  | issues scoped run token
  v
Sandbox
  |
  | runs sandbox-runner process
  | runs agent loop
  | executes tools
  | reads/writes workspace filesystem
  | reports events/files/artifacts/sources through ingest API
  v
Control Plane Ingest API
  |
  | verifies scoped run token
  | validates run state and ownership
  | writes facts idempotently
  v
Postgres + Object Storage
```

硬边界：

- Agent loop 在 sandbox 内运行，而不是在 Next.js server process 内。
- Sandbox 永远不能拿数据库凭证。
- Sandbox 永远不能拿 Better Auth user session cookie。
- Sandbox 默认不拿长期 LLM credentials。
- Sandbox 只拿短期 scoped run token。
- Control Plane 是 user ownership、run state、credits、events、files、artifacts、sources 的事实源。

## 3. 核心概念

### 3.1 Workspace

用户拥有的长期研究工作区。

例子：

- “AI coding agent 市场研究”
- “OpenClaw 对比分析”
- “cloud-agent-platform 仓库分析”

Workspace 拥有：

- threads
- runs
- workspace files
- artifacts
- sources
- sandbox state

### 3.2 Thread

Workspace 内的一条对话线或任务线。

不要用 `Session` 表示这个业务概念，因为 Better Auth 已经有 auth sessions。

Thread 拥有：

- user messages
- assistant messages
- runs

### 3.3 Run

用户消息触发的一次 agent 执行。

Run 拥有：

- run status
- agent events
- tool calls
- file changes
- sources
- artifacts
- credit reservation and debit records

### 3.4 Workspace File

Sandbox workspace 文件系统里的文件。

Workspace files 是工作材料，可以是 notes、raw fetches、命令输出、报告草稿、临时 JSON、克隆的 repo 或中间分析结果。

Workspace files 不会自动成为用户正式交付物。

### 3.5 Artifact

从 agent 输出或 workspace files 中提升出来的正式交付物。

Artifacts 应该稳定、在 UI 中可见、可导出，并能追踪到产生它的 run 和 sources。

例子：

- research report
- comparison table
- interview brief
- implementation plan
- code change summary

规则：

- `write_file` 创建或更新 workspace files。
- `create_artifact` 创建用户可见 artifact。
- Artifact 可以引用 workspace file path。
- Artifact 应该保存 content snapshot 或 object storage key，确保 workspace file 后续变化后 artifact 仍可恢复。

## 4. 开发规则

### 4.1 API-First

每个 workflow 都必须先用 API 和测试闭环，再做 UI。

每个 feature 的顺序：

1. 写 API contract。
2. 写纯逻辑 unit tests。
3. 写 route 或 integration tests。
4. 实现 server behavior。
5. 验证测试通过。
6. 最后基于 API 做 UI。

### 4.2 TDD 要求

每个 phase 都必须包含：

- 先写哪些测试
- 实现任务
- 涉及的 API endpoints
- 数据库变更
- 验收检查
- 运行命令

Phase 完成标准：

- 本 phase 的测试通过。
- API happy path 不依赖 UI 即可跑通。
- 关键失败场景有覆盖。
- 对外行为变化时文档已更新。

### 4.3 测试分层

测试层级：

- unit tests：无网络、无 DB、无 sandbox、无 LLM
- route tests：API handlers + test DB 或隔离记录
- integration tests：真实 DB、真实 sandbox，可选真实 LLM
- e2e tests：API workflows 已证明后再做浏览器级验证

### 4.4 Phase Gate

每个 phase 结束后：

- 运行列出的命令
- 写阶段摘要
- 停下来 review，再进入下一阶段

## 5. 数据模型草案

Better Auth 拥有 auth tables。业务表不要复用 `Session` 这个名字。

业务表：

```text
Workspace
WorkspaceMember
Thread
Message
Run
AgentEvent
ToolCall
WorkspaceFile
WorkspaceFileVersion
Artifact
ArtifactVersion
Source
LLMUsageRecord
SandboxInstance
RunToken
```

> `CreditLedger`/`CreditBalance` 已废弃，替换为 `LLMUsageRecord`（纯用量遥测，不做 reserve/debit/refund 强制执行，见 [ADR-0015](./decisions/0015-usage-telemetry-and-ops-priorities.md)）。

P0 简化：

- `WorkspaceMember` 可以只做 owner-only。
- 如果 `WorkspaceFile` 只存 latest state，可以先省略 `WorkspaceFileVersion`。
- `ArtifactVersion` 可以先由 `Artifact.version` 表示。
- `RunToken` 可以是 signed token；如果需要撤销和审计，再持久化。

最小 P0 字段见 [docs/data-model.md](./data-model.md)。这份路线图的 Phase 划分已过时（未吃进 ADR-0018~0022），完整替代版本见 [docs/implementation-roadmap.md](./implementation-roadmap.md)。

## 6. API 契约草案

所有 JSON API 使用统一响应信封：

```json
{
  "code": 0,
  "message": "ok",
  "data": {}
}
```

核心 endpoints 见 [docs/api-contract.md](./api-contract.md)。

## 7. Run 状态机

```text
created
  -> provisioning_sandbox
  -> running
  -> cancel_requested
  -> cancelled

running
  -> completed
  -> failed
  -> timeout

provisioning_sandbox
  -> failed
  -> timeout
  -> cancel_requested
```

完整状态机见 [docs/state-machines.md](./state-machines.md)。

## 8. Phase Plan

### Phase 0：重置产品和规格

目标：

先把新方向讲清楚，再改代码。

先写测试：

- 不需要代码测试。
- 增加文档 review checklist。

文档任务：

- [ ] 重写 PRD。
- [ ] 创建 agent-in-sandbox 技术设计。
- [ ] 创建 API contract。
- [ ] 创建 data model。
- [ ] 创建从当前 `Session` 模型迁移到 `Thread` 的计划。
- [ ] 归档或更新过时文档。

验收：

- 文档不再互相矛盾。
- 明确区分 auth session 和 business thread。
- 明确区分 workspace file 和 artifact。

命令：

```bash
pnpm lint
pnpm test
pnpm build
```

### Phase 1：测试和质量基线

目标：

让现有仓库进入可安全重构状态。

先写测试：

- 更新当前预期行为的测试。
- 在大重构前修掉过期测试。

任务：

- [ ] 修复或更新 `useSessionState` 里关于 SSE done refetch 的失败测试。
- [ ] 决定 test files 的 lint 策略。
- [ ] 移除或开关化 frontend hooks 里的 debug `console.log`。
- [ ] 修复生产代码 lint errors。
- [ ] 默认 unit tests 和 integration tests 分离。

验收：

- `pnpm test` 通过。
- `pnpm build` 通过。
- `pnpm lint` 通过，或有明确临时例外和修复计划。

### Phase 2：Better Auth 基础

目标：

用真实用户账号替代邀请码门禁。

先写测试：

- auth helper 已登录/未登录行为。
- `GET /api/me` route test。
- 未登录访问 protected endpoint 返回 unauthorized。
- 已登录访问 protected endpoint 返回当前 user。

API：

```text
GET /api/me
```

任务：

- [ ] 安装和配置 Better Auth。
- [ ] 生成或添加 Better Auth schema tables。
- [ ] 增加 server auth helper，例如 `requireUser()`。
- [ ] 添加 `/api/me`。
- [ ] 给业务 API 增加 route protection helper。
- [ ] 避免当前业务 `Session` 和 auth session 混淆。

验收：

- 用户可以注册/登录。
- API 可以识别当前用户。
- 未登录 API 访问被拒绝。
- Auth tables 和业务 thread 没有命名/语义冲突。

### Phase 3：Workspace API

目标：

创建用户拥有的顶层 workspace 模型。

先写测试：

- workspace title validation。
- create workspace。
- list only current user's workspaces。
- unauthorized user cannot read another user's workspace。
- update workspace title。
- archive/delete workspace。

API：

```text
GET /api/workspaces
POST /api/workspaces
GET /api/workspaces/:workspaceId
PATCH /api/workspaces/:workspaceId
DELETE /api/workspaces/:workspaceId
```

验收：

- Workspace CRUD 完全通过 API tests 闭环。
- 跨用户访问不可能。
- 此阶段不需要 UI。

### Phase 4：Thread 和 Message API

目标：

支持 workspace 下多个 threads。

先写测试：

- thread title derivation。
- create thread inside workspace。
- list threads inside workspace。
- create user message。
- thread detail includes messages and runs。
- cross-workspace/cross-user access rejection。

API：

```text
GET /api/workspaces/:workspaceId/threads
POST /api/workspaces/:workspaceId/threads
GET /api/threads/:threadId
PATCH /api/threads/:threadId
```

验收：

- 已登录用户可以通过 API 创建 workspace 和 thread。
- Thread 可以保存 user/assistant messages。
- Auth sessions 不再和 business threads 混淆。

### Phase 5：Run 状态机和 Event Store

目标：

在引入 sandbox 前，先让 run lifecycle 可预测。

先写测试：

- legal run transitions。
- invalid run transitions。
- terminal state guard。
- event seq monotonicity。
- duplicate event idempotency。
- create run / get run / cancel run route tests。
- SSE snapshot 包含 persisted events。

API：

```text
POST /api/threads/:threadId/runs
GET /api/runs/:runId
POST /api/runs/:runId/cancel
GET /api/runs/:runId/events
```

验收：

- Run lifecycle 不依赖 sandbox 即可工作。
- SSE 可以 stream 手动插入事件。
- Refresh 可以从 DB 恢复 events。

### Phase 6：Scoped Run Token

目标：

让 sandbox 只能为一个 run 写入事实。

先写测试：

- token signing and verification。
- token expiration。
- token cannot be used for another workspace/run。
- ingest rejects missing/expired token。
- ingest accepts valid token。

API：

```text
POST /api/ingest/events
POST /api/ingest/heartbeat
```

验收：

- Sandbox 用合法 token 可以写 event。
- Token 不能跨 run/thread/workspace/user。
- Token 过期后不可用。

### Phase 7：Ingest API 基线

目标：

先不接真实 runner，证明 sandbox-to-control-plane persistence 链路。

先写测试：

- append event through ingest。
- heartbeat updates run。
- tool call start/completion。
- terminal run rejects new event。
- duplicate event idempotency。

API：

```text
POST /api/ingest/events
POST /api/ingest/tool-calls
POST /api/ingest/heartbeat
```

验收：

- 测试可以 create run、mint token、call ingest、再通过 `GET /api/runs/:id` 读到 events。
- Sandbox 不需要 DB access。

### Phase 8：Sandbox Provider 和 Fake Runner

目标：

先不用真实 LLM，证明 agent-in-sandbox 进程形态。

先写测试：

- sandbox name generation。
- create/resume sandbox integration。
- upload runner files or bootstrap command。
- start fake runner in sandbox。
- fake runner reports events through ingest。
- fake runner completes run。

Sandbox runner input：

```json
{
  "runId": "run_xxx",
  "workspaceId": "ws_xxx",
  "threadId": "thr_xxx",
  "ingestUrl": "https://app.example.com/api/ingest",
  "llmProxyUrl": "https://app.example.com/api/llm-proxy",
  "runToken": "...",
  "workspaceRoot": "/workspace"
}
```

验收：

- 测试证明 loop process 确实在 sandbox 内运行。
- Control Plane 只通过 ingest 观察。
- SSE 显示 fake runner events。

### Phase 9：Workspace File Ingest

目标：

从 sandbox 写文件后，持久化 workspace file metadata 和小文本内容。

先写测试：

- path guard。
- content hash。
- file size policy。
- ingest file metadata。
- ingest small text content。
- reject path traversal。
- file list/content API。

API：

```text
POST /api/ingest/files
GET /api/workspaces/:workspaceId/files
GET /api/workspaces/:workspaceId/files/content?path=
POST /api/workspaces/:workspaceId/files/upload-url
```

验收：

- fake sandbox runner 写文件并 ingest。
- API 可以 list/read 文件。
- path traversal 被拒绝。

### Phase 10：Artifact Ingest

目标：

让 artifact 显式、版本化、用户可见。

先写测试：

- artifact validation。
- artifact version allocation。
- ingest artifact from content。
- ingest artifact from workspace file path。
- artifact list/detail。
- artifact 不能引用其他用户 workspace file。

API：

```text
POST /api/ingest/artifacts
GET /api/workspaces/:workspaceId/artifacts
GET /api/artifacts/:artifactId
GET /api/artifacts/:artifactId/download
```

Sandbox tool：

```text
create_artifact({ title, kind, path?, content?, sourceRefs? })
```

验收：

- runner 写 `reports/foo.md`。
- runner 调 `create_artifact`。
- API 列表出现 artifact。
- API 能读取 artifact content。
- Workspace file 和 artifact 区分清楚。

### Phase 11：Source Recording

目标：

追踪研究结论来源。

先写测试：

- source URL validation。
- ingest URL/file source。
- source list by workspace/run。
- artifact source references。

API：

```text
POST /api/ingest/sources
GET /api/workspaces/:workspaceId/sources
GET /api/runs/:runId/sources
```

验收：

- Research run 可以记录 URL 和本地文件作为 sources。
- Artifact 可以引用 sources。

### Phase 12：LLM Proxy

目标：

长期 LLM credentials 留在 Control Plane，sandbox 只调 scoped proxy。

先写测试：

- model config resolution。
- missing key error。
- llm proxy rejects missing run token。
- llm proxy rejects terminal run。
- llm proxy records usage。
- fake LLM proxy stream integration。

API：

```text
POST /api/llm-proxy
```

验收：

- Sandbox 不拿 provider key 也能调用 LLM。
- Usage 可归属到 user/workspace/thread/run。

### Phase 13：真实 Sandbox Agent Loop

目标：

用真实 research agent loop 替换 fake runner。

先写测试：

- runner starts and loads thread context。
- runner calls LLM proxy。
- runner calls `write_file`。
- runner calls `create_artifact`。
- runner reports tool calls。
- runner completes run。
- cancellation stops runner。
- timeout converges to terminal status。

Sandbox tools：

```text
web_search
fetch_url
list_files
read_file
write_file
run_command
create_artifact
record_source
```

验收：

- real run 可以研究一个主题。
- agent 写 workspace files。
- agent 创建 markdown artifact。
- browser/API 可以恢复所有 events 和 artifact data。

### Phase 14：Credit Ledger

目标：

用可审计 ledger 实现点数。

先写测试：

- ledger balance calculation。
- reserve/debit/refund。
- idempotency key。
- balance endpoint。
- insufficient credits rejects run creation。
- run reserves/debits/refunds。

Ledger types：

```text
grant
reserve
debit
refund
adjustment
```

验收：

- 点数不足不能启动 run。
- 每次余额变化可审计。
- 重试不会重复扣费。

### Phase 15：Control Plane Orchestration

目标：

把 workspace、thread、run、sandbox、ingest、files、artifacts、sources、credits 串成一个完整 API workflow。

先写测试：

- full API happy path。
- cancel path。
- timeout path。
- insufficient credits path。

验收：

- 完整 product workflow 在 UI 前已由 API 和测试证明。

### Phase 16：UI Shell

目标：

API 稳定后再做 UI。

先写测试：

- component test workspace sidebar。
- component test thread list。
- component test run timeline。
- component test artifact list。
- component test credit balance display。

UI layout：

```text
Left sidebar
  user and credit balance
  new workspace
  workspace list
  current workspace thread list

Main
  thread messages
  active run timeline
  input box

Right panel or tabs
  files
  artifacts
  sources
```

验收：

- UI 只使用已存在 API。
- 正确性不依赖 UI-only hidden state。
- Refresh 从 DB snapshot 恢复。

### Phase 17：Browser E2E

目标：

API 证明正确后，再验证用户可见流程。

先写测试：

- login/register。
- create workspace。
- create thread。
- start research run。
- observe events。
- open artifact。
- cancel run。

验收：

- 浏览器 happy path 可用。
- 默认 E2E 不依赖 flaky real LLM。

### Phase 18：部署和运维

目标：

安全部署，并保证 stuck runs 可收敛。

先写测试：

- orphan sweep logic。
- sweep marks stale running run as timeout/interrupted。
- sandbox resume from stored state。
- snapshot restore if supported。

验收：

- Production build 可部署。
- stuck run 不会永久 running。
- secrets 不进 repo。
- logs 能定位 runId/workspaceId，且不泄露敏感内容。

## 9. 最小 API Happy Path

新 UI 完成前必须先跑通：

```text
1. register/login user
2. GET /api/me
3. POST /api/workspaces
4. POST /api/workspaces/:workspaceId/threads
5. POST /api/threads/:threadId/runs
6. Control Plane creates run token
7. Control Plane starts sandbox runner
8. sandbox runner POST /api/ingest/events run_started
9. sandbox runner POST /api/ingest/files notes/research.md
10. sandbox runner POST /api/ingest/artifacts research report
11. sandbox runner POST /api/ingest/events run_completed
12. GET /api/runs/:runId shows terminal state and events
13. GET /api/workspaces/:workspaceId/files shows file
14. GET /api/workspaces/:workspaceId/artifacts shows artifact
15. GET /api/credits/ledger shows charge/refund records
```

## 10. 推荐构建顺序

如果时间有限，严格按这个顺序：

1. 修复当前测试和 build 基线。
2. Better Auth。
3. Workspace。
4. Thread。
5. Run and event store。
6. Scoped run token。
7. Ingest API。
8. Fake sandbox runner。
9. Workspace files。
10. Artifacts。
11. Sources。
12. LLM proxy。
13. Real sandbox agent。
14. Credits。
15. UI。
16. E2E。
17. Deployment。

最难的架构里程碑不是 LLM 效果，而是证明 loop 确实在 sandbox 内运行，并且所有持久化事实都通过 ingest APIs 回到 Control Plane，sandbox 不直接访问数据库。


# Technical Design — Personal Task Workspace Agent

## 1. 设计目标

P0 目标是做出一个能讲清楚、能 demo 的 cloud task workspace：

- agent 在 sandbox 内执行
- control plane 负责状态、调度、事件和 artifact
- workspace 保存任务上下文和产物
- 用户能看过程、能取消、能继续追问

不追求企业级全量能力。架构保留演进空间，但实现只做 P0。

## 2. 顶层架构

```text
Browser
  |
  | REST: create workspace / start run / cancel / read artifact
  | SSE: run stream
  v
Control Plane (Next.js)
  |
  | Postgres: workspace / run / event / tool_call / source / artifact
  | Sandbox Provider: create or reuse sandbox
  | Token Service: issue scoped run token
  v
Sandbox
  |
  | agent loop
  | tools: search / fetch / file / command
  | local workspace files
  | artifact writer
  v
Ingest API
  |
  | verify scoped run token
  | idempotent write events/tool calls/artifacts/sources
  v
Postgres
```

## 3. 核心边界

### 3.1 Control Plane

可信服务端。

职责：

- 创建 workspace
- 创建 run
- 管理 run 状态机
- 调度 sandbox
- 签发 scoped run token
- 接收 sandbox 事件
- 持久化 event / tool call / artifact / source
- 向浏览器提供 REST/SSE
- 处理 cancel / timeout / orphan sweep

Control Plane 可以持有：

- Postgres 凭证
- Redis 凭证，如后续需要
- sandbox provider 凭证
- LLM route 配置

### 3.2 Sandbox

不可信执行环境。

职责：

- 运行 agent loop
- 执行工具
- 读写 workspace 文件
- 写 artifact
- 上报事件

Sandbox 不允许持有：

- Postgres 凭证
- Redis 凭证
- 长期 user token
- 跨 workspace 权限

Sandbox 只能拿到当前 run 的 scoped run token。

### 3.3 Trust Boundary

边界画在 sandbox 外侧：

```text
trusted:
  Browser auth -> Control Plane -> Postgres

untrusted:
  Sandbox -> tools -> network/files/commands
```

原因：

- agent 可能执行 LLM 生成的命令
- workspace 内容可能不可信
- 网页内容可能包含 prompt injection
- 用户项目代码可能有副作用

所以 sandbox 是隔离执行层，不是事实源。

## 4. P0 组件

### 4.1 Browser UI

P0 页面结构：

```text
左侧：workspace / artifact list
中间：artifact viewer
右侧：task chat + event timeline
```

关键能力：

- 创建 workspace
- 提交 task
- 查看 run 状态
- 查看 event timeline
- 查看 artifact
- cancel run
- 继续追问

### 4.2 Workspace Service

负责 workspace 元数据。

P0 简化：

- 单用户
- workspace 不做成员系统
- workspace 可以对应一个长期 sandbox handle

### 4.3 Run Orchestrator

负责 run lifecycle。

状态机：

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
```

终态：

- `completed`
- `failed`
- `cancelled`
- `timeout`

原则：

- 终态不可被覆盖
- cancel 请求必须能打断 running
- 超时必须收敛

### 4.4 Sandbox Provider

统一 sandbox 抽象。

```ts
interface SandboxProvider {
  createOrResume(workspaceId: string): Promise<SandboxHandle>;
  getWarm(workspaceId: string): Promise<SandboxHandle | null>;
  stop(handle: SandboxHandle): Promise<void>;
}

interface SandboxHandle {
  id: string;
  workspaceId: string;
  baseUrl: string;
  status: "provisioning" | "warm" | "dead";
}
```

P0 可支持：

- local sandbox，用于开发和稳定 demo
- Vercel sandbox，用于 cloud demo

接口保持一致，避免业务层关心 provider。

### 4.5 Sandbox Agent Runtime

Sandbox 内提供一个 agent server：

```text
GET  /health
POST /runs
POST /runs/:runId/cancel
GET  /files
GET  /files/*
PUT  /files/*
POST /exec
```

`POST /runs` 输入：

```json
{
  "runId": "run_xxx",
  "workspaceId": "ws_xxx",
  "prompt": "research task",
  "assistantProfile": {},
  "ingestUrl": "https://control-plane/api/ingest",
  "runToken": "scoped-token"
}
```

Sandbox agent loop 做：

1. 加载 prompt 和 assistant profile
2. 加载 workspace 文件、notes、已有 artifacts
3. 调 LLM
4. 调工具
5. 写事件
6. 生成 artifact
7. 上报 completed/failed/cancelled/timeout

### 4.6 Ingest API

Sandbox 通过 ingest API 上报事实。

```text
POST /api/ingest/events
POST /api/ingest/tool-calls
POST /api/ingest/sources
POST /api/ingest/artifacts
```

P0 可以合并成一个端点：

```text
POST /api/ingest
```

请求：

```json
{
  "workspaceId": "ws_xxx",
  "runId": "run_xxx",
  "seq": 12,
  "type": "artifact.created",
  "payload": {}
}
```

幂等键：

```text
event_id = run_id + ":" + seq
```

校验：

- token 未过期
- token 绑定当前 run
- token 绑定当前 workspace
- seq 合法

## 5. 数据模型

P0 最小表：

```text
users
assistant_profiles
workspaces
runs
agent_events
tool_calls
sources
artifacts
sandbox_instances
```

### 5.1 users

P0 可以只有一个本地用户，但保留 user 表方便演进。

字段：

- `id`
- `email`
- `name`
- `created_at`

### 5.2 assistant_profiles

保存用户偏好和边界。

字段：

- `id`
- `user_id`
- `language`
- `working_style`
- `risk_policy`
- `output_preferences`
- `created_at`
- `updated_at`

P0 可先用 JSON。

### 5.3 workspaces

字段：

- `id`
- `user_id`
- `title`
- `goal`
- `status`
- `created_at`
- `updated_at`

### 5.4 runs

字段：

- `id`
- `workspace_id`
- `status`
- `prompt`
- `started_at`
- `completed_at`
- `last_heartbeat_at`
- `max_duration_ms`
- `error`
- `created_at`

### 5.5 agent_events

字段：

- `id`
- `workspace_id`
- `run_id`
- `seq`
- `type`
- `payload`
- `created_at`
- `ingested_at`

约束：

- `UNIQUE(run_id, seq)`

### 5.6 tool_calls

字段：

- `id`
- `workspace_id`
- `run_id`
- `event_id`
- `tool_name`
- `args`
- `result`
- `status`
- `started_at`
- `completed_at`

### 5.7 sources

记录 artifact 或结论引用的来源。

字段：

- `id`
- `workspace_id`
- `run_id`
- `type`：`web` / `file` / `repo` / `command_output`
- `title`
- `url`
- `path`
- `snippet`
- `metadata`
- `created_at`

### 5.8 artifacts

字段：

- `id`
- `workspace_id`
- `run_id`
- `type`：`report` / `draft` / `plan` / `notes` / `code_summary`
- `title`
- `path`
- `content`
- `metadata`
- `created_at`
- `updated_at`

P0 可以把 markdown content 存 DB，也可以同时写入 sandbox 文件。

### 5.9 sandbox_instances

字段：

- `id`
- `workspace_id`
- `provider`
- `provider_handle`
- `base_url`
- `status`
- `last_activity_at`
- `created_at`
- `updated_at`

## 6. API Contract

### 6.1 Workspace

```text
POST /api/workspaces
GET  /api/workspaces
GET  /api/workspaces/:workspaceId
```

Create workspace：

```json
{
  "title": "OpenClaw comparison",
  "goal": "Compare OpenClaw with Personal Task Workspace Agent"
}
```

### 6.2 Runs

```text
POST /api/workspaces/:workspaceId/runs
GET  /api/runs/:runId
GET  /api/runs/:runId/stream
POST /api/runs/:runId/cancel
```

Start run：

```json
{
  "prompt": "Generate a product positioning report"
}
```

### 6.3 Artifacts

```text
GET /api/workspaces/:workspaceId/artifacts
GET /api/artifacts/:artifactId
```

### 6.4 Sources

```text
GET /api/workspaces/:workspaceId/sources
GET /api/sources/:sourceId
```

### 6.5 Assistant Profile

```text
GET   /api/assistant-profile
PATCH /api/assistant-profile
```

P0 可以先不做 UI，只提供服务端默认 profile。

### 6.6 Ingest

```text
POST /api/ingest
```

只允许 scoped run token 调用。

## 7. Run 执行链路

### 7.1 Start Run

```text
1. Browser POST /api/workspaces/:id/runs
2. Control Plane 创建 run(status=created)
3. Control Plane 获取或创建 sandbox
4. Control Plane 签发 scoped run token
5. Control Plane 调 sandbox POST /runs
6. Control Plane 标记 run=running
7. Browser 订阅 SSE
```

### 7.2 Agent Execution

```text
1. Sandbox agent 收到 manifest
2. 加载 assistant profile
3. 调 search/fetch/file/exec tools
4. 每一步生成 event
5. 通过 ingest API 上报
6. 写 artifact
7. 上报 run completed
```

### 7.3 Event Streaming

```text
1. Ingest API 写 agent_events
2. SSE route 从 DB 读增量事件
3. Browser 渲染 timeline
4. 刷新页面后从 DB 恢复
```

P0 不强依赖 Redis pub/sub。可以先用 DB polling + SSE。

### 7.4 Cancel

```text
1. Browser POST /api/runs/:id/cancel
2. Control Plane status -> cancel_requested
3. Control Plane 调 sandbox POST /runs/:id/cancel
4. Sandbox abort controller 取消 agent loop
5. Sandbox 上报 run.cancelled
6. Control Plane status -> cancelled
```

要求：

- sandbox cancel endpoint 必须快速返回
- agent loop 必须把 abort signal 传给 LLM 和工具
- terminal status 不可被后续事件覆盖

### 7.5 Timeout

四层兜底：

1. LLM first-response timeout
2. 单工具 timeout
3. run max duration
4. sweep orphan runs

目标：任何 run 最终都要进入终态。

## 8. Tool System

P0 工具：

| Tool | 用途 | 风险控制 |
|---|---|---|
| `search_web` | 搜索资料 | 限制结果数量 |
| `fetch_url` | 读取网页 | 超时、大小限制、记录 source |
| `list_files` | 查看 workspace 文件 | path guard |
| `read_file` | 读取文件 | path guard |
| `write_file` | 写 artifact/notes | path guard |
| `run_command` | 执行低风险命令 | denylist、timeout、输出截断 |

高风险命令默认拒绝：

- `rm -rf`
- `sudo`
- `dd`
- fork bomb
- 修改系统目录
- 访问 workspace 外路径

## 9. Artifact Workflow

Artifact 是 P0 的核心交付。

生成规则：

- 每个完成的 research/write task 至少生成一个 artifact
- artifact 必须有 title/type/content
- artifact 尽量关联 sources
- artifact 创建必须产生 event

示例 event：

```json
{
  "type": "artifact.created",
  "payload": {
    "artifactId": "art_xxx",
    "title": "OpenClaw comparison report",
    "type": "report"
  }
}
```

## 10. Security

P0 安全原则：

- sandbox 不可信
- control plane 不执行 agent 生成命令
- DB/Redis 凭证不下发 sandbox
- scoped run token 短期有效
- token 绑定 workspace/run
- path guard 限制文件操作范围
- command policy 拦截高风险命令
- event ingest 幂等

## 11. Warm Sandbox Reuse

P0 做 warm reuse，不做 freeze/thaw。

策略：

```text
if workspace has warm sandbox:
  reuse
else:
  create new sandbox
```

复用价值：

- 保留 workspace 文件
- 减少 cold start
- 支持继续追问

P1 再考虑：

- freeze to object storage
- thaw from snapshot
- warm pool

## 12. Implementation Phases

### Phase 1：文档和产品收口

- 保留 `prd.md`
- 保留 `technical-design.md`
- 旧文档归档

### Phase 2：当前 PoC 复盘

- 确认现有 agent 改文件链路
- 确认 LLM fallback/cancel 单测
- 标注哪些还在 server，哪些已在 sandbox

### Phase 3：Sandbox Agent Loop

- sandbox 内新增 runner
- control plane 只负责编排
- sandbox 上报事件

### Phase 4：Artifact + Source

- artifact 表/接口
- source 表/接口
- report markdown 展示

### Phase 5：Cancel / Timeout / Warm Reuse

- cancel 1s demo
- first-response timeout
- run timeout
- orphan sweep
- warm sandbox reuse

## 13. Open Questions

1. P0 的 web search 使用外部 search API，还是先用 fetch 用户给定 URL？
2. Artifact content 存 DB，还是只存文件 path？
3. local sandbox 是否作为 P0 demo 主路径？
4. Assistant Profile 是配置文件、DB 表，还是 UI 可编辑？
5. P0 是否需要简单登录，还是固定单用户？

建议默认答案：

- search 先抽象 tool，具体 provider 可替换
- artifact markdown 先存 DB，另写 workspace 文件
- local sandbox 做稳定 demo，Vercel sandbox 做加分
- profile 先用默认配置
- P0 固定单用户


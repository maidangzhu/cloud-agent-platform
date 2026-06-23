# 数据模型 (Data Model) — Cloud Agent Platform

本文档定义平台的数据库表结构。平台状态以 Postgres 为唯一事实源（参见 [`architecture.md`](./architecture.md) 第 2 节三类状态边界）。

## 1. 概览

平台采用**多轮会话模型**（决策见 [ADR-0002](./adr/0002-multi-turn-session.md)）：一个 `Session` 是一次长期会话容器，绑定一个可复用的沙箱 workspace；用户每发一条消息触发一次 `Run`（一轮 agent 执行）。P0 共 7 张表：

```
Session（会话容器）
  ├─ Workspace   1:1   沙箱引用（命名沙箱 + snapshot，可会话内复用、沙箱回收后恢复）
  ├─ Message[]   1:N   用户 ↔ agent 的对话消息（user / assistant）
  └─ Run[]       1:N   每次用户发消息触发的一轮 agent 执行
       ├─ AgentEvent[]   一次 Run 内的执行事件流（事实源）
       ├─ ToolCall[]     工具调用明细
       └─ Artifact[]     产出报告
```

| 表 | 含义 | 关系 |
| --- | --- | --- |
| `Session` | 长期会话容器 | 根对象 |
| `Workspace` | 会话绑定的沙箱引用（不存文件系统） | Session 1:1 |
| `Message` | 用户与 agent 的对话消息 | Session 1:N |
| `Run` | 一次 agent 执行（一条 prompt → 一轮 loop） | Session 1:N |
| `AgentEvent` | Run 内的执行事件流 | Run 1:N |
| `ToolCall` | 一次工具调用及结果 | Run 1:N |
| `Artifact` | 最终报告或生成文件 | Run 1:N |

**两层 message 的区分**（关键设计）：

- `Message` 表 = **用户视角的对话**（你说一句 user，agent 答一句 assistant）。
- `AgentEvent` = **某条 assistant 消息背后那次 Run 的执行细节**（模型每一步、工具调用、结果）。

一次典型 Run：1 条 user `Message` 触发 → N 条 `AgentEvent`（过程）→ 1 条 assistant `Message` + `Artifact`（结果）。

设计原则：

- **热查询字段结构化**：`sessionId / runId / status / seq / createdAt` 等都是独立列。
- **原始数据用 JSON**：LLM 原始输出、工具参数、sandbox 元数据保留 JSON（Prisma `Json` / Postgres JSONB）。
- **事件按行追加**：`AgentEvent` append-only，便于分页、检索、审计、恢复。
- **沙箱只存引用**：`Workspace` 存 `sandboxName / sandboxState / snapshotId`，不存文件系统本身。

## 2. P0 表结构（Prisma schema）

```prisma
model Session {
  id             String        @id @default(cuid())
  inviteCodeHash String?                              // 邀请码 hash，不存明文
  title          String                               // 会话标题（由首条 prompt 生成）
  status         SessionStatus @default(active)
  workspace      Workspace?
  messages       Message[]
  runs           Run[]
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt

  @@index([status, createdAt])
}

model Workspace {
  id                 String          @id @default(cuid())
  sessionId          String          @unique
  session            Session         @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  provider           String          @default("local")   // "local" | "vercel"
  status             WorkspaceStatus @default(pending)
  sandboxName        String?                              // 命名沙箱，getOrCreate 复用（① 文件延续）
  sandboxState       Json?                                // 重连引用
  snapshotId         String?                              // 最近快照，用于 resume（② 快照恢复）
  snapshotExpiresAt  DateTime?                            // 快照保留期
  workingDir         String?
  error              String?
  createdAt          DateTime        @default(now())
  updatedAt          DateTime        @updatedAt
}

model Message {
  id        String   @id @default(cuid())
  sessionId String
  session   Session  @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  role      String                                       // "user" | "assistant"
  content   String                                       // 文本内容（Markdown）
  runId     String?                                      // assistant 消息关联的那次 Run
  createdAt DateTime @default(now())

  @@index([sessionId, createdAt])
}

model Run {
  id              String    @id @default(cuid())
  sessionId       String
  session         Session   @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  userPrompt      String                                 // 触发这次 Run 的用户 prompt
  status          RunStatus @default(created)
  maxSteps        Int       @default(60)                  // 步数上限，防失控
  maxDurationSec  Int       @default(780)                 // wall time 上限
  startedAt       DateTime?
  completedAt     DateTime?
  lastHeartbeatAt DateTime?                               // 心跳，用于中断判定
  error           String?
  events          AgentEvent[]
  toolCalls       ToolCall[]
  artifacts       Artifact[]
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@index([sessionId, createdAt])
  @@index([status, createdAt])
}

model AgentEvent {
  id        String   @id @default(cuid())
  runId     String
  run       Run      @relation(fields: [runId], references: [id], onDelete: Cascade)
  seq       Int                                          // run 内单调递增序号
  type      String                                       // run_created / model_step / tool_call_started ...
  role      String?                                      // user / assistant / tool
  title     String?
  content   String?
  raw       Json?                                        // 原始模型输出 / 元数据
  createdAt DateTime @default(now())

  @@unique([runId, seq])                                 // 保证事件顺序事实源
  @@index([runId, createdAt])
}

model ToolCall {
  id          String         @id @default(cuid())
  runId       String
  run         Run            @relation(fields: [runId], references: [id], onDelete: Cascade)
  eventSeq    Int
  name        String                                     // list_files / read_file / search_text / write_file / run_command
  status      ToolCallStatus @default(pending)
  args        Json
  result      Json?
  error       String?
  startedAt   DateTime       @default(now())
  completedAt DateTime?

  @@index([runId, eventSeq])
  @@index([name, status])
}

model Artifact {
  id        String   @id @default(cuid())
  runId     String
  run       Run      @relation(fields: [runId], references: [id], onDelete: Cascade)
  kind      String                                       // "report" 等
  title     String?
  path      String?
  content   String?
  metadata  Json?
  createdAt DateTime @default(now())
}

enum SessionStatus {
  active
  archived
}

enum RunStatus {
  created
  provisioning_workspace
  running
  completed
  failed
  timeout
  cancel_requested
  cancelled
  interrupted
}

enum WorkspaceStatus {
  pending
  provisioning
  ready
  archived
  failed
}

enum ToolCallStatus {
  pending
  running
  completed
  failed
  timeout
  rejected
}
```

## 3. 事件类型（AgentEvent.type）

事件流是 UI 展示、审计、刷新恢复的基础。P0 主要事件：

```text
run_created
workspace_provisioning
workspace_ready
workspace_resumed        (从 snapshot 恢复时)
agent_started
model_step               (assistant 一轮输出)
tool_call_started
tool_call_completed
tool_call_failed
artifact_created
run_completed
run_failed
run_timeout
cancel_requested
run_cancelled
agent_heartbeat
```

约束（见 spec `event-persistence`）：`seq` 在 run 内单调递增且唯一；`run_created` 早于 `agent_started`；每个工具的 `tool_call_started` 早于其 `tool_call_completed`；终态后不再追加普通运行事件。

## 4. Workspace 生命周期与 snapshot/resume

多轮会话下 workspace 必须跨请求、跨沙箱实例存活。采用分层策略（详见 [`sandbox-research.md`](./sandbox-research.md) 第 5 节）：

| 层 | 机制 | DB 字段 | 范围 |
| --- | --- | --- | --- |
| ① 文件延续 | persistent 命名沙箱，`getOrCreate({name})` 活着复用、死了重建 | `sandboxName` `sandboxState` | **P0 必做** |
| ② 快照恢复 | 沙箱停止前 `snapshot()`，回来从 `snapshotId` resume | `snapshotId` `snapshotExpiresAt` | **P0 增强** |
| ③ 自动 hibernate 编排 | 定时判断空闲→休眠→lease | —（不建字段） | **P1，不做** |

「过两天回来继续对话」的恢复路径：
1. 对话上下文：读 `Session.messages`（DB 永久）→ 100% 恢复。
2. 文件状态：`getOrCreate(sandboxName)` 发现原沙箱已被回收 → 从 `snapshotId` resume 重建（一次冷启动）→ 文件恢复。

边界：snapshot 存**文件系统**，不存**运行进程**（后台 dev server 不会复活）；本项目场景（读仓库/改文件/生成报告）不需要长驻进程。

## 5. 与 Open Agents 的对照

参考项目 Vercel Open Agents（生产级）用 15 张表（Drizzle + Postgres + JSONB）：

| 分组 | 表 |
| --- | --- |
| 认证/账号 | `users` `accounts` `auth_sessions` `verification` |
| 集成 | `github_installations` `vercel_project_links` |
| 会话 | `sessions` |
| 对话 | `chats` `chat_messages` `chat_reads` `shares` |
| 执行 | `workflow_runs` `workflow_run_steps` |
| 其他 | `user_preferences` `usage_events` |

**我们借鉴的关键设计**：

- `sessions.sandboxState`（JSONB）保存 sandbox 状态、**不保存文件系统** → 我们的 `Workspace.sandboxState` 同理。
- `sessions.lifecycleState` + snapshot 字段管理 sandbox 生命周期 → 我们简化为 `snapshotId`（做 ①②，不做 ③ 编排）。
- `chat_messages` 按行存对话 → 我们的 `Message` 表同理。
- 把"会话""对话消息""执行实例"分表 → 我们对应 `Session` / `Message` / `Run`。

**我们的差异（P0 做减法）**：

| 维度 | Open Agents | 我们 P0 | 原因 |
| --- | --- | --- | --- |
| 表数量 | 15 | 7 | 砍掉 auth/计费/集成 |
| 会话分层 | `sessions`→`chats`→`chat_messages` 三层 | `Session`→`Message` 两层 | 不区分 session 下多个 chat |
| 执行记录 | `workflow_runs`+`workflow_run_steps` 一条消息一行 parts | `Run`+`AgentEvent`+`ToolCall` 细粒度事件流 | 更利于时间线展示与审计 |
| sandbox 生命周期 | `lifecycleState` 7 态 + 自动 hibernate workflow | `snapshotId` + 命名沙箱复用，无自动编排 | P0 不做 ③ |
| 防重复执行 | `activeStreamId` 占坑 | `lastHeartbeatAt` 心跳 | P0 不上 durable workflow |

> 落库粒度差异：Open Agents 用 AI SDK + Vercel Workflow，一条 UI message 一行；我们用 Pi，通过 `subscribe(event)` 把每个事件 map 成 `AgentEvent`/`ToolCall` 行。两者边界一致，粒度不同。详见 [`architecture.md`](./architecture.md) 第 6 节。

## 6. P1 演进（本期不建表）

| 对象 | 何时需要 |
| --- | --- |
| `User` | 做公开产品、多用户 |
| `Project` | 支持多仓库 / 多项目（多个 Session 归属一个 repo 项目） |
| `WorkspaceSnapshot` | 保留多份历史快照、快照版本管理 |
| `QueueJob` | 后台任务调度、横向扩展 worker |
| sandbox lifecycle 编排 | 自动 hibernate/resume（③）、lease、定时检查 |

P1 关系：一个 User 有多个 Project；一个 Project 有多个 Session；其余不变。P1 会给 `Run` 增补 `workerId` / `leaseExpiresAt` / `retryCount` / `resumeFromEventSeq`（断点续跑）。

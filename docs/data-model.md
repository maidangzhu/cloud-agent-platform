# 数据模型 — Research Workspace Agent

这份文档定义 v2 的数据库模型意图。

Prisma schema 是最终实现产物；本文档解释每张表为什么存在、哪些字段是事实源、哪些约束和测试必须保护。Prisma schema 位于 `packages/db`（[ADR-0022](./decisions/0022-monorepo-hono-backend.md)），只被 `apps/api`（Hono Control Plane）依赖，前端不直接访问。

## 1. 原则

- Better Auth 拥有 auth tables。
- 业务对话对象命名为 `Thread`，不叫 `Session`。
- Workspace 是授权边界。
- 每张 workspace-scoped 表都存 `workspaceId`。
- events 和 credits 优先使用 append-only 事实记录。
- current-state 表可以缓存最新状态，但不能隐藏产生它们的事实记录。
- Sandbox 永远不能直接写数据库。

## 2. 表清单

```text
Better Auth
- user
- session
- account
- verification

Business
- Workspace
- WorkspaceMember
- Thread
- Message
- Run
- AgentEvent
- ToolCall
- WorkspaceFile
- WorkspaceFileVersion
- Artifact
- ArtifactVersion
- Source
- SandboxInstance
- RunToken
- LLMUsageRecord
```

P0 可以省略：

- 如果只做 owner-only 访问，可以省略 `WorkspaceMember`。
- 如果只存文件 latest metadata，可以省略 `WorkspaceFileVersion`。
- 如果 `Artifact.version` 和 latest content 足够，可以省略 `ArtifactVersion`。
- 如果使用签名无状态 token，可以省略 `RunToken`。
- `CreditBalance`/`CreditLedger` 已废弃（[ADR-0015](./decisions/0015-usage-telemetry-and-ops-priorities.md)），不需要再考虑是否省略。

## 3. 表规格

### 3.1 Workspace

用途：

顶层研究工作区。

字段：

```text
id              String   primary key
ownerUserId     String   Better Auth user id
title           String
status          WorkspaceStatus
fileRevision    BigInt   workspace file monotonic revision watermark
createdAt       DateTime
updatedAt       DateTime
archivedAt      DateTime?
```

索引：

```text
ownerUserId, updatedAt
status, updatedAt
```

不变量：

- `ownerUserId` 必填。
- archived workspace 不能启动新 run。
- P0 下用户只能读取自己的 workspace。

### 3.2 WorkspaceMember

用途：

未来多人协作和权限。

P0：

可选。如果实现，创建 workspace 时同步创建 owner membership。

字段：

```text
id              String primary key
workspaceId     String
userId          String
role            WorkspaceRole
createdAt       DateTime
```

约束：

```text
unique(workspaceId, userId)
```

角色：

```text
owner
editor
viewer
```

### 3.3 Thread

用途：

Workspace 内的对话/任务线。

字段：

```text
id              String primary key
workspaceId     String
title           String
status          ThreadStatus
createdAt       DateTime
updatedAt       DateTime
archivedAt      DateTime?
```

索引：

```text
workspaceId, updatedAt
status, updatedAt
```

不变量：

- Thread 属于一个 workspace。
- Thread 不是 Better Auth session。

### 3.4 Message

用途：

用户/assistant 对话记录。

字段：

```text
id              String primary key
workspaceId     String
threadId        String
runId           String?
role            MessageRole
content         String
metadata        Json?
createdAt       DateTime
```

索引：

```text
threadId, createdAt
workspaceId, createdAt
runId
```

角色：

```text
user
assistant
system
```

P0：

UI 只暴露 user 和 assistant messages。

### 3.5 Run

用途：

一次 sandbox agent 执行。

字段：

```text
id                  String primary key
workspaceId         String
threadId            String
userId              String
prompt              String
status              RunStatus
maxSteps            Int
maxDurationSec      Int
startedAt           DateTime?
completedAt         DateTime?
lastHeartbeatAt     DateTime?
error               String?
creditReserved      Int?
creditDebited       Int?
createdAt           DateTime
updatedAt           DateTime
```

索引：

```text
workspaceId, createdAt
threadId, createdAt
userId, createdAt
status, createdAt
```

不变量：

- `workspaceId` 必须匹配 thread 的 workspace。
- P0 下 `userId` 必须匹配 workspace owner。
- 终态不可覆盖。

### 3.6 AgentEvent

用途：

Append-only run 审计事件。

字段：

```text
id              String primary key
workspaceId     String
threadId        String
runId           String
seq             Int
type            String
role            String?
title           String?
content         String?
raw             Json?
createdAt       DateTime
```

约束：

```text
unique(runId, seq)
```

索引：

```text
runId, seq
workspaceId, createdAt
threadId, createdAt
type, createdAt
```

不变量：

- `seq` 在同一个 run 内严格递增。
- 重复 ingest 同一个 `(runId, seq)` 必须幂等或可预测地拒绝。
- 普通事件不能追加到终态 run。

### 3.7 ToolCall

用途：

持久化工具调用记录。

字段：

```text
id              String primary key
workspaceId     String
runId           String
eventSeq        Int
name            String
status          ToolCallStatus
args            Json
result          Json?
error           String?
startedAt       DateTime
completedAt     DateTime?
```

索引：

```text
runId, eventSeq
workspaceId, startedAt
name, status
```

状态：

```text
pending
running
completed
failed
timeout
rejected
```

### 3.8 WorkspaceFile

用途：

Workspace 文件的最新 metadata/content pointer。

字段：

```text
id              String primary key
workspaceId     String
path            String
kind            WorkspaceFileKind
mimeType        String?
size            Int
contentHash     String
content         String?
storageKey      String?
latestRunId     String?
revision        BigInt
isDeleted       Boolean
createdAt       DateTime
updatedAt       DateTime
```

约束：

```text
unique(workspaceId, path)
```

索引：

```text
workspaceId, updatedAt
workspaceId, path
workspaceId, revision
latestRunId
```

不变量：

- Path 必须规范化。
- Path 不能逃逸 workspace root。
- 小文本内容存 `content`。
- 大文件或二进制内容存对象存储并设置 `storageKey`。
- `contentHash` 必须存在。
- 内容、metadata 或删除状态变化时，必须从 `Workspace.fileRevision` 原子取得新 revision。
- 删除采用 `isDeleted=true` 的 tombstone，不能物理删除后丢失同步指令。

### 3.9 WorkspaceFileVersion

用途：

可选文件历史。

P0：

可以省略。

字段：

```text
id              String primary key
workspaceId     String
fileId          String
runId           String?
path            String
size            Int
contentHash     String
content         String?
storageKey      String?
createdAt       DateTime
```

### 3.10 Artifact

用途：

正式用户交付物。

字段：

```text
id                  String primary key
workspaceId         String
threadId            String?
runId               String
title               String
kind                ArtifactKind
path                String?
contentSnapshot     String?
storageKey          String?
version             Int
metadata            Json?
createdAt           DateTime
updatedAt           DateTime
```

索引：

```text
workspaceId, updatedAt
threadId, updatedAt
runId, createdAt
kind, updatedAt
```

不变量：

- Artifact 必须属于一个 workspace。
- Artifact 必须由一个 run 创建。
- Artifact 必须能从 `contentSnapshot` 或 `storageKey` 恢复。
- Artifact 可以指向 workspace file path，但不能只依赖可变的 latest file content。

类型：

```text
text
code
sheet
image
```

P0：

只要求支持 `text`。

### 3.11 ArtifactVersion

用途：

Artifact 版本历史。

P0：

如果 artifact 不可变或只存 latest content，可以省略。

字段：

```text
id                  String primary key
workspaceId         String
artifactId          String
version             Int
contentSnapshot     String?
storageKey          String?
createdByRunId      String?
createdAt           DateTime
```

约束：

```text
unique(artifactId, version)
```

### 3.12 Source

用途：

研究证据。

字段：

```text
id              String primary key
workspaceId     String
runId           String?
artifactId      String?
kind            SourceKind
uri             String?
title           String?
contentHash     String?
metadata        Json?
createdAt       DateTime
```

索引：

```text
workspaceId, createdAt
runId, createdAt
artifactId, createdAt
kind, createdAt
```

类型：

```text
url
file
command
search_result
manual
```

### 3.13 SandboxInstance

用途：

Control Plane 记录 workspace sandbox 状态。

字段：

```text
id                  String primary key
workspaceId         String
provider            String
sandboxName         String
status              SandboxStatus
currentRunId        String?
state               Json?
snapshotId          String?
snapshotExpiresAt   DateTime?
syncedUpToRevision  BigInt?
pendingSyncRevision BigInt?
workingDir          String?
lastUsedAt          DateTime?
createdAt           DateTime
updatedAt           DateTime
```

`currentRunId`（[ADR-0018](./decisions/0018-atomic-state-transitions.md) 新增）：当前占用该沙箱的 run id，`NULL` 表示空闲可复用。认领动作必须走条件原子 UPDATE（`WHERE status IN ('warm','ready') AND current_run_id IS NULL`），防止两个并发的 getOrCreate 请求抢到同一个沙箱。Run 进入终态或 `waiting_for_input` 时必须原子清空该字段。同时是排障用的可观测性字段——可以直接看到某个沙箱当前被哪个 run 占用。

`syncedUpToRevision` 为 `NULL` 表示 provider sandbox 从未完成文件同步或刚被 fresh recreate；非空值表示当前仍存活的 ephemeral working copy 已确认同步到的 WorkspaceFile revision。session 停止并 fresh create 后必须清空该水位线并全量水合。`pendingSyncRevision` 由 Control Plane 在 runner 启动前写入，只有 `run_completed` side effect 能在释放 sandbox 前把它推进为 `syncedUpToRevision`；失败、取消、timeout 不推进。

索引：

```text
workspaceId, updatedAt
provider, sandboxName
status, updatedAt
currentRunId
```

### 3.14 RunToken

用途：

可选的持久化 scoped run token。

字段：

```text
id              String primary key
tokenHash       String unique
userId          String
workspaceId     String
threadId        String
runId           String
scopes          String[]
expiresAt       DateTime
revokedAt       DateTime?
createdAt       DateTime
```

索引：

```text
runId, createdAt
expiresAt
```

P0 替代方案：

使用服务端 secret 签名的无状态 token。持久化 token 更适合撤销和审计。

### 3.15 LLMUsageRecord（原 CreditLedger，[ADR-0015](./decisions/0015-usage-telemetry-and-ops-priorities.md) 改为用量遥测）

用途：

Append-only LLM 调用用量记录，纯观测，不产生"拒绝执行"的业务后果。原 `CreditLedger` 的 reserve/debit/refund 强制执行机制已废弃——本项目单人使用，没有"额度耗尽必须拒绝"的真实场景。

字段：

```text
id                  String primary key
runId               String
provider            String
model               String
promptTokens        Int?
completionTokens    Int?
totalTokens         Int?
ttfbMs              Int?
durationMs          Int?
cost                Float?
createdAt           DateTime
```

索引：

```text
runId, createdAt
provider, createdAt
model, createdAt
```

不变量：

- Append-only，是用量事实源。
- 不做扣费判断，`cost` 字段（如有）纯展示用。
- 每次 `POST /api/llm-proxy` 或 `POST /api/search-proxy` 调用后记一条。

### 3.16 CreditLedger / CreditBalance（已废弃，见 [ADR-0015](./decisions/0015-usage-telemetry-and-ops-priorities.md)）

原设计的 reserve → debit → refund 强制执行账本已废弃，替换为上面的 `LLMUsageRecord`。不删除本节记录，标注为被 ADR-0015 取代，供查阅历史决策脉络。

## 4. 枚举

```text
WorkspaceStatus
- active
- archived

ThreadStatus
- active
- archived

RunStatus
- created
- provisioning_sandbox
- running
- waiting_for_input
- cancel_requested
- completed
- failed
- timeout
- cancelled
- interrupted

WorkspaceFileKind
- text
- binary
- directory

ArtifactKind
- text
- code
- sheet
- image

SandboxStatus
- pending
- provisioning
- ready
- warm
- stopped
- failed

```

> `CreditLedgerType` 枚举已随 `CreditLedger` 表废弃（[ADR-0015](./decisions/0015-usage-telemetry-and-ops-priorities.md)）。`LLMUsageRecord` 不需要类型枚举，是单一形态的用量记录。

## 5. 删除和归档策略

P0：

- Workspace 和 thread 优先 archive，不直接 hard delete。
- Hard delete 只用于测试清理或 admin tools。
- 除非 workspace 被显式 purge，否则 child records 保留用于审计。

未来：

- 增加用户数据导出。
- 增加完整 workspace purge。

## 6. 从 v1 迁移的说明

当前 v1 概念：

```text
Session -> Thread
Run.sessionId -> Run.threadId + Run.workspaceId
Message.sessionId -> Message.threadId + Message.workspaceId
Workspace.sessionId -> Workspace.id as top-level object
```

推荐 v2 路径：

1. 新建 v2 schema，而不是在 v1 上原地扭转。
2. v1 branch 保留为参考。
3. v2 API 直接使用新命名。
4. 除非必须迁移已有数据，否则不保留兼容层。

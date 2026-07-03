# API 契约 — Research Workspace Agent

这份文档定义 v2 HTTP API 契约。

每个 endpoint 都必须先有 route tests，再实现 UI。

## 1. 响应信封

所有 JSON API 响应统一使用：

```json
{
  "code": 0,
  "message": "ok",
  "data": {}
}
```

失败响应：

```json
{
  "code": 1001,
  "message": "bad request",
  "data": null
}
```

## 2. 错误码

```text
0       OK
1001    BAD_REQUEST
1002    UNAUTHORIZED
1003    FORBIDDEN
1004    NOT_FOUND
1005    CONFLICT
1006    VALIDATION_FAILED

2001    RUN_NOT_CANCELABLE
2002    RUN_TOKEN_INVALID
2003    RUN_TERMINAL
2004    INGEST_SEQ_CONFLICT
2005    INVALID_STATE_TRANSITION
2006    WORKSPACE_ARCHIVED
2007    SANDBOX_CLAIM_CONFLICT

3001    SEARCH_PROXY_FAILED

4001    SANDBOX_FAILED
4002    SANDBOX_UNAVAILABLE
4003    LLM_PROXY_FAILED

5000    INTERNAL
```

> 3001/3002（`INSUFFICIENT_CREDITS`/`CREDIT_IDEMPOTENCY_CONFLICT`）已随 [ADR-0015](./decisions/0015-usage-telemetry-and-ops-priorities.md) 移除——credit 改为用量遥测，不做强制执行，不再有"额度不足拒绝"这类错误路径。新增 2006（workspace 归档后拒绝创建 run/thread，对应 [ADR-0018](./decisions/0018-atomic-state-transitions.md) insert-select 返回 0 行的场景）、2007（SandboxInstance 认领竞态落败，同一 ADR）、3001（`web_search` 走的 search proxy 失败，[ADR-0020](./decisions/0020-agent-event-payload-schema-and-tool-retry.md)）。

HTTP status 映射：

```text
OK                          200
BAD_REQUEST                 400
VALIDATION_FAILED           400
UNAUTHORIZED                401
FORBIDDEN                   403
NOT_FOUND                   404
CONFLICT                    409
RUN_NOT_CANCELABLE          409
RUN_TOKEN_INVALID           401
RUN_TERMINAL                409
INGEST_SEQ_CONFLICT         409
WORKSPACE_ARCHIVED          409
SANDBOX_CLAIM_CONFLICT      409
SEARCH_PROXY_FAILED         502
SANDBOX_FAILED              502
INTERNAL                    500
```

## 3. Auth

浏览器 API 使用 Better Auth cookie。

Sandbox API 使用 scoped run token：

```text
Authorization: Bearer <run-token>
```

规则：

- Browser user endpoints 需要 Better Auth session。
- Ingest 和 LLM proxy 需要 run token。
- Run token 不能当浏览器登录态使用。
- Better Auth cookie 不能当 ingest auth 使用。

## 4. DTO

### UserDTO

```ts
type UserDTO = {
  id: string;
  email?: string;
  name?: string;
};
```

### WorkspaceDTO

```ts
type WorkspaceDTO = {
  id: string;
  title: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
};
```

### ThreadDTO

```ts
type ThreadDTO = {
  id: string;
  workspaceId: string;
  title: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
};
```

### MessageDTO

```ts
type MessageDTO = {
  id: string;
  workspaceId: string;
  threadId: string;
  runId?: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};
```

### RunDTO

```ts
type RunDTO = {
  id: string;
  workspaceId: string;
  threadId: string;
  status:
    | "created"
    | "provisioning_sandbox"
    | "running"
    | "waiting_for_input"
    | "cancel_requested"
    | "completed"
    | "failed"
    | "timeout"
    | "cancelled"
    | "interrupted";
  prompt: string;
  derivedUiState:
    | "idle"
    | "running"
    | "possibly_running"
    | "cancelling"
    | "waiting_for_input"
    | "completed"
    | "failed"
    | "timeout"
    | "cancelled"
    | "interrupted";
  waitingForInput?: { question: string; options?: string[] };
  startedAt?: string;
  completedAt?: string;
  lastHeartbeatAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};
```

`waiting_for_input`（[ADR-0019](./decisions/0019-waiting-for-input-state.md)）：非终态，agent 主动停下等用户选择。`waitingForInput` 字段仅在该状态下出现，来自对应 `run_waiting_for_input` 事件的 payload，供前端 composer 渲染提示条（见 [design-system.md](./design-system.md) §9.3）。

### AgentEventDTO

`payload` 按 `type` 定义判别联合，不再是 `unknown`（[ADR-0020](./decisions/0020-agent-event-payload-schema-and-tool-retry.md)）。核心原则：**thinking/content（走 [ADR-0017](./decisions/0017-token-accumulation-and-persistence-timing.md) 攒批落库路径）和 tool_call（一次性完整对象）不共用同一套字段**。

```ts
type AgentEventPayloadMap = {
  run_created: null;
  sandbox_provisioning: null;
  sandbox_ready: null;
  runner_started: null;
  agent_started: null;

  // ADR-0017：语义边界触发落库，thinking/content 各自在完整时落一次。
  // 完整文本放 AgentEventDTO.content，payload 只带辅助信息。
  agent_thinking: { model?: string };
  agent_message: { messageId: string };

  // tool_call：一次性完整对象，不走攒批路径。
  tool_call_started: { toolCallId: string; name: string; args: unknown };
  tool_call_completed: { toolCallId: string; name: string; result: unknown; durationMs?: number };
  tool_call_failed: { toolCallId: string; name: string; error: string; durationMs?: number };

  file_written: { fileId: string; path: string; size: number; contentHash: string };
  source_recorded: { sourceId: string; kind: SourceDTO["kind"]; uri?: string; title?: string };

  artifact_started: { artifactId: string; title: string; kind: ArtifactDTO["kind"] };
  artifact_delta: { artifactId: string; deltaText: string };
  artifact_created: { artifactId: string; title: string; kind: ArtifactDTO["kind"]; version: number };
  artifact_updated: { artifactId: string; title: string; kind: ArtifactDTO["kind"]; version: number; previousVersion: number };
  artifact_failed: { artifactId?: string; error: string };

  run_completed: { totalTokens?: number; durationMs: number };
  run_failed: { errorCode?: string };
  run_timeout: { lastHeartbeatAt?: string };
  run_cancelled: null;
  run_waiting_for_input: { question: string; options?: string[] };
};

type AgentEventDTO<T extends keyof AgentEventPayloadMap = keyof AgentEventPayloadMap> = {
  seq: number;
  type: T;
  role?: string;
  title?: string;
  content?: string;
  payload: AgentEventPayloadMap[T];
  createdAt: string;
};
```

`model_step`（旧的含糊类型）已被 `agent_thinking`/`agent_message` 取代，不删除旧文档记录，标注为已被取代。

### ToolCallDTO

```ts
type ToolCallDTO = {
  id: string;
  runId: string;
  eventSeq: number;
  name: string;
  status: "pending" | "running" | "completed" | "failed" | "timeout" | "rejected";
  args: unknown;
  result?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
};
```

### WorkspaceFileDTO

```ts
type WorkspaceFileDTO = {
  id: string;
  workspaceId: string;
  path: string;
  kind: "text" | "binary" | "directory";
  mimeType?: string;
  size: number;
  contentHash: string;
  latestRunId?: string;
  createdAt: string;
  updatedAt: string;
};
```

### ArtifactDTO

```ts
type ArtifactDTO = {
  id: string;
  workspaceId: string;
  threadId?: string;
  runId: string;
  title: string;
  kind: "text" | "code" | "sheet" | "image";
  path?: string;
  contentSnapshot?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};
```

### SourceDTO

```ts
type SourceDTO = {
  id: string;
  workspaceId: string;
  runId?: string;
  artifactId?: string;
  kind: "url" | "file" | "command" | "search_result" | "manual";
  uri?: string;
  title?: string;
  contentHash?: string;
  metadata?: unknown;
  createdAt: string;
};
```

### LLMUsageRecordDTO

替代原 `CreditBalanceDTO`/`CreditLedger`（[ADR-0015](./decisions/0015-usage-telemetry-and-ops-priorities.md)）。Credit 改为用量遥测，不做 reserve/debit/refund 强制执行，纯粹给自己复盘用。

```ts
type LLMUsageRecordDTO = {
  id: string;
  runId: string;
  provider: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  ttfbMs?: number;
  durationMs?: number;
  cost?: number;
  createdAt: string;
};
```

## 5. Endpoints

### 5.1 当前用户

```text
GET /api/me
```

Auth：

- 需要 Better Auth。

响应：

```ts
type MeData = {
  user: UserDTO;
};
```

测试：

- 未登录 -> 401
- 已登录 -> 返回 user

### 5.2 Workspaces

```text
GET /api/workspaces
POST /api/workspaces
GET /api/workspaces/:workspaceId
PATCH /api/workspaces/:workspaceId
DELETE /api/workspaces/:workspaceId
```

Create request：

```ts
type CreateWorkspaceRequest = {
  title: string;
};
```

List response：

```ts
type WorkspaceListData = {
  workspaces: WorkspaceDTO[];
};
```

规则：

- 用户只能看到自己的 workspaces。
- P0 中 delete 表示 archive。
- 空 title 拒绝。

测试：

- create success
- list own workspaces
- cannot read another user's workspace
- archive workspace

### 5.3 Threads

```text
GET /api/workspaces/:workspaceId/threads
POST /api/workspaces/:workspaceId/threads
GET /api/threads/:threadId
PATCH /api/threads/:threadId
```

Create request：

```ts
type CreateThreadRequest = {
  title?: string;
  initialPrompt?: string;
};
```

Thread detail response：

```ts
type ThreadDetailData = {
  thread: ThreadDTO;
  messages: MessageDTO[];
  runs: RunDTO[];
};
```

规则：

- Thread 属于 workspace。
- 用户必须拥有 workspace。
- title 为空时，从 initial prompt 推导或使用默认标题。

测试：

- create thread
- list workspace threads
- get thread detail
- cannot access thread in another user's workspace

### 5.4 Runs

```text
POST /api/threads/:threadId/runs
GET /api/runs/:runId
POST /api/runs/:runId/cancel
GET /api/runs/:runId/events
```

Create request：

```ts
type CreateRunRequest = {
  prompt: string;
};
```

Create response：

```ts
type CreateRunData = {
  run: RunDTO;
};
```

Run detail response：

```ts
type RunDetailData = {
  run: RunDTO;
  events: AgentEventDTO[];
  toolCalls: ToolCallDTO[];
  artifacts: ArtifactDTO[];
  sources: SourceDTO[];
};
```

规则：

- 如果 thread 存在一个 `waiting_for_input` 的 run，先原子转其为 `completed`（[ADR-0019](./decisions/0019-waiting-for-input-state.md)），再创建新 run。
- Workspace/Thread 必须为 `active`，否则用 insert-select 原子拒绝（返回 `WORKSPACE_ARCHIVED`，[ADR-0018](./decisions/0018-atomic-state-transitions.md)），不做"先查后建"两步式判断。
- 创建 user message。
- 创建 `created` 状态的 run。
- Orchestrator 可以异步启动 sandbox runner。
- 只有非终态 run（含 `waiting_for_input`）可以 cancel。

测试：

- create run success
- archived workspace/thread rejects run creation（WORKSPACE_ARCHIVED）
- creating run while a waiting_for_input run exists first completes the old run
- cancel running run
- cancel waiting_for_input run
- cancel terminal run rejected
- get run detail

### 5.5 SSE Run Events

```text
GET /api/runs/:runId/events
```

事件：

```text
snapshot
ping
done
<AgentEvent.type>   （包括 run_waiting_for_input，见 ADR-0019）
```

Snapshot data：

```ts
type RunSnapshotData = {
  run: RunDTO;
  events: AgentEventDTO[];
};
```

规则：

- 浏览器端需要 Better Auth。
- 用户必须拥有 run 所在 workspace。
- 终态 run 发送 snapshot 后发送 done。
- `waiting_for_input` run 发送 snapshot 后发送 done（sandbox 已退出，没有更多事件；`run.waitingForInput` 字段已包含在 snapshot 里，见 [RunDTO](#dto)）。
- active run 发送 snapshot、新事件、ping，终态后发送 done。
- token 级 delta（[ADR-0021](./decisions/0021-token-stream-relay-redis-streams.md)）经独立的 Redis Streams 转发通道，不经过这条 `AgentEvent` snapshot/SSE 路径；实现细节：有 `Last-Event-ID` header 就从该 cursor 之后 `XREAD` 续读，没有就从 stream 起始（`"0"`）读取。

测试：

- unauthenticated rejected
- terminal run returns done
- waiting_for_input run returns snapshot with question then done
- active run streams new event
- snapshot includes historical events
- reconnect with Last-Event-ID resumes from cursor without duplicate or loss（ADR-0021）

### 5.6 Workspace Files

```text
GET /api/workspaces/:workspaceId/files
GET /api/workspaces/:workspaceId/files/content?path=<path>
POST /api/workspaces/:workspaceId/files/upload-url
```

规则：

- 用户必须拥有 workspace。
- Path 必须规范化。
- Content endpoint 只返回已存储的 text content，或按策略返回 signed read URL。

测试：

- list files
- read text file content
- reject path traversal
- reject another user's workspace

### 5.7 Artifacts

```text
GET /api/workspaces/:workspaceId/artifacts
GET /api/artifacts/:artifactId
GET /api/artifacts/:artifactId/versions
GET /api/artifacts/:artifactId/download
```

List response：

```ts
type ArtifactListData = {
  artifacts: ArtifactDTO[];
};
```

Detail response：

```ts
type ArtifactDetailData = {
  artifact: ArtifactDTO;
  sources: SourceDTO[];
};
```

Versions response（此前完全未定义，本轮补齐——见 memory 记录的独立缺口清单）：

```ts
type ArtifactVersionDTO = {
  version: number;
  contentSnapshot?: string;
  storageKey?: string;
  createdByRunId?: string;
  createdAt: string;
};

type ArtifactVersionsData = {
  versions: ArtifactVersionDTO[];
};
```

Download response：

```ts
type ArtifactDownloadData = {
  filename: string;
  mimeType: string;
  // 二者恰好一个非空：小内容直接返回，大内容返回签名 URL。
  content?: string;
  downloadUrl?: string;
};
```

规则：

- 用户必须拥有 workspace。
- Artifact detail 包含 content snapshot 或 read URL。
- P0 可以只返回单个 latest version；`versions` 端点即使 P0 只有一个版本也必须返回长度为 1 的数组（保持响应形状稳定，不因版本数量变化而改变类型）。
- `artifact_updated` 产生的新版本必须能通过 `versions` 端点看到旧版本仍可读。

测试：

- list artifacts
- get artifact detail
- get artifact versions（含多版本场景，验证 artifact_updated 产生的新版本）
- get artifact download（content 与 downloadUrl 二选一）
- cannot read another user's artifact
- artifact remains readable after workspace file changes

### 5.8 Sources

```text
GET /api/workspaces/:workspaceId/sources
GET /api/runs/:runId/sources
```

规则：

- 用户必须拥有 workspace 或 run 所在 workspace。

测试：

- list workspace sources
- list run sources
- source can reference artifact

### 5.9 Usage（原 Credits，[ADR-0015](./decisions/0015-usage-telemetry-and-ops-priorities.md) 改为纯用量遥测）

```text
GET /api/usage/records
```

Response：

```ts
type UsageRecordsData = {
  records: LLMUsageRecordDTO[];
};
```

规则：

- 用户只能看到自己 workspace 下 run 产生的用量记录。
- List 需要分页（支持按 `runId`/`provider`/`model` 过滤）。
- 不产生任何"拒绝执行"的业务后果——纯观测记录，不是余额/额度。

测试：

- list own usage records only
- filter by runId
- filter by provider/model
- pagination works

## 6. Ingest APIs

Ingest APIs 由 sandbox runner 使用 scoped run token 调用。

### 6.1 Events

```text
POST /api/ingest/events
```

Request：

```ts
type IngestEventRequest<T extends keyof AgentEventPayloadMap = keyof AgentEventPayloadMap> = {
  seq: number;
  type: T;
  role?: string;
  title?: string;
  content?: string;
  payload: AgentEventPayloadMap[T];
  idempotencyKey?: string;
};
```

规则：

- Token 绑定 run/workspace/thread/user。
- Seq 在同一个 run 内唯一。
- 重复相同事件在 body 一致时应该幂等。
- 终态 run 拒绝普通新事件（`waiting_for_input` 视为非终态但不接受新事件，除了它自身触发的那一条）。
- `payload` 必须匹配 `type` 对应的 schema（[ADR-0020](./decisions/0020-agent-event-payload-schema-and-tool-retry.md)），形状不匹配返回 `VALIDATION_FAILED`。

### 6.2 Heartbeat

```text
POST /api/ingest/heartbeat
```

Request：

```ts
type HeartbeatRequest = {
  seq?: number;
  status?: "running";
  phase?: "boot" | "load_context" | "agent_loop" | "finalize";
};
```

`phase` 对应 [agent-runtime-protocol.md](./agent-runtime-protocol.md) §5 Runner 生命周期阶段，此前文档缺失该字段（已知漂移，本轮补齐），用于诊断"卡在哪个阶段"（[ADR-0007](./decisions/0007-stuck-diagnosis-model.md)）。

规则：

- 更新 `Run.lastHeartbeatAt`。
- 默认不创建可见事件，避免噪音。

### 6.3 Tool Calls

```text
POST /api/ingest/tool-calls
```

Request：

```ts
type IngestToolCallRequest = {
  id: string;
  eventSeq: number;
  name: string;
  status: ToolCallDTO["status"];
  args: unknown;
  result?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
};
```

### 6.4 Files

```text
POST /api/ingest/files
```

Request：

```ts
type IngestFileRequest = {
  path: string;
  kind: "text" | "binary" | "directory";
  mimeType?: string;
  size: number;
  contentHash: string;
  content?: string;
  storageKey?: string;
  eventSeq?: number;
};
```

规则：

- 拒绝 path traversal。
- 强制 content size limit。
- 按 `(workspaceId, path)` upsert。

### 6.5 Artifacts

```text
POST /api/ingest/artifacts
```

Request：

```ts
type IngestArtifactRequest = {
  artifactId?: string;
  title: string;
  kind: ArtifactDTO["kind"];
  path?: string;
  contentSnapshot?: string;
  storageKey?: string;
  sourceIds?: string[];
  eventSeq?: number;
};
```

Response：

```ts
type IngestArtifactData = {
  artifact: ArtifactDTO;
};
```

规则：

- 必须包含可恢复内容：`contentSnapshot`、`storageKey`，或一个可用于抽取 snapshot 的合法 file path。
- `artifactId` 留空或指向不存在的 id → 首次创建，`version = 1`，如果提供 `eventSeq` 则创建 `artifact_created` 事件。
- `artifactId` 指向已存在的 artifact → 新版本（`version + 1`），如果提供 `eventSeq` 则创建 `artifact_updated` 事件（[ADR-0020](./decisions/0020-agent-event-payload-schema-and-tool-retry.md)）。
- 版本号分配必须原子（`UPDATE ... SET version = version + 1 RETURNING version` 或等价一步操作，遵循 [ADR-0018](./decisions/0018-atomic-state-transitions.md) 的原则）。

### 6.6 Sources

```text
POST /api/ingest/sources
```

Request：

```ts
type IngestSourceRequest = {
  kind: SourceDTO["kind"];
  uri?: string;
  title?: string;
  contentHash?: string;
  metadata?: unknown;
  artifactId?: string;
  eventSeq?: number;
};
```

### 6.7 Stream Chunk（[ADR-0021](./decisions/0021-token-stream-relay-redis-streams.md)，转发专用，不落库）

```text
POST /api/ingest/stream-chunk
```

Request：

```ts
type IngestStreamChunkRequest = {
  chunk: string;
  streamType: "thinking" | "content";
};
```

规则：

- Control Plane 内部执行 `XADD run:{runId}:stream * chunk "<chunk>" type "<streamType>"`，不写数据库。
- 不需要 `seq`/`idempotencyKey`（Streams entry ID 单调递增，天然充当去重和排序依据）。
- run 进入终态或 `waiting_for_input` 后拒绝新 chunk。
- 与 `POST /api/ingest/events` 完全独立，互不阻塞（[ADR-0011](./decisions/0011-dual-channel-streaming.md)）。

测试：

- accepts chunk for active run
- rejects chunk for terminal run
- chunk does not create AgentEvent row
- SSE consumer can XREAD chunk immediately after XADD

## 7. LLM Proxy

```text
POST /api/llm-proxy
```

Auth：

- scoped run token

规则：

- Token 必须匹配 active run。
- Control Plane 持有模型凭证。
- Usage 需要记录（落一条 `LLMUsageRecord`，纯遥测，不做扣费判断，见 [ADR-0015](./decisions/0015-usage-telemetry-and-ops-priorities.md)）。
- Request/response 内部可以适配 provider，但 sandbox runner 应使用稳定 wrapper contract。
- `finish_reason`（或等价语义边界信号）必须在响应中归一化提供，供 runner 判断攒批落库时机（[ADR-0009](./decisions/0009-provider-anti-corruption-layer.md)/[ADR-0017](./decisions/0017-token-accumulation-and-persistence-timing.md)）。

测试：

- reject missing token
- reject terminal run
- records usage as LLMUsageRecord
- returns model output in fake provider mode
- normalizes finish_reason across providers

## 8. Search Proxy（[ADR-0020](./decisions/0020-agent-event-payload-schema-and-tool-retry.md)，解决 DQ-3）

```text
POST /api/search-proxy
```

Auth：

- scoped run token

Request：

```ts
type SearchProxyRequest = {
  query: string;
  limit?: number;
};
```

Response：

```ts
type SearchProxyResult = {
  url: string;
  title: string;
  snippet?: string;
};

type SearchProxyData = {
  results: SearchProxyResult[];
};
```

规则：

- Token 必须匹配 active run。
- Control Plane 持有 provider key（如 Brave），key 不进沙箱。
- Control Plane 记录用量（`LLMUsageRecord` 同构记录，`provider` 字段标注为 search provider）。
- 超时 10s；网络失败/5xx 最多重试 2 次，指数退避（500ms/1500ms）；4xx 不重试，直接返回 `SEARCH_PROXY_FAILED`。
- HTML 清洗放在 sandbox runner 侧，本端点只返回归一化的结果列表（url/title/snippet）。

测试：

- reject missing token
- reject terminal run
- returns normalized results in fake provider mode
- retries on 5xx up to 2 times
- does not retry on 4xx
- records usage


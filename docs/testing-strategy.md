# 测试策略 — API-First TDD

这份文档定义 v2 的测试驱动开发方式。

规则：

每个 workflow 都必须先通过 API 和测试闭环，再实现 UI。

## 1. 测试分层

### 1.1 Unit Tests

目的：

验证无外部依赖的纯逻辑。

不能依赖：

- database
- network
- sandbox
- real LLM
- 除简单本地 fixtures 外的 filesystem

测试目标：

- state machines
- validation
- path guard
- policy guard（含 SSRF guard，ADR-0020）
- token signing/parsing
- usage 记录形状校验（不再是 credit math，ADR-0015）
- DTO conversion
- event ordering
- idempotency helpers
- 条件原子 UPDATE 辅助函数（`transitionRun`，ADR-0018）

命令：

```bash
pnpm test
```

### 1.2 Route Tests

目的：

验证 API 行为。

可以使用：

- test database 或隔离测试记录
- mocked auth helper
- mocked sandbox orchestrator
- fake search/LLM proxy provider

必须覆盖：

- auth required
- ownership checks
- request validation
- response envelope
- error codes
- DTO shape

### 1.3 Integration Tests

目的：

验证真实组件边界。

可以使用：

- real Postgres test database
- real Vercel sandbox
- fake sandbox runner
- fake LLM proxy

默认集成套件不应该依赖：

- flaky real LLM

命令：

```bash
pnpm test:integration
```

### 1.4 Real Provider Smoke Tests

目的：

证明生产 wiring 可用。

可以使用：

- real Vercel sandbox
- real LLM relay/provider
- real object storage

规则：

- 缺少 credentials 时自动 skip。
- 断言保持最小。
- 不要求每次本地运行都执行。

### 1.5 Browser E2E

目的：

在 API 稳定后验证用户可见流程。

默认使用：

- fake runner mode
- deterministic test data

必须覆盖：

- login
- create workspace
- create thread
- start run
- see events
- open artifact
- cancel run

## 2. TDD 工作流

每个 feature：

1. 新增或更新 API contract。
2. 写纯逻辑 unit tests。
3. 写 API route tests。
4. 如果跨 sandbox/DB/LLM 边界，写 integration test。
5. 实现最小代码。
6. 跑测试。
7. 重构。
8. 最后再做 UI。

不要让 UI 依赖“想象中的后端行为”。

## 3. 必需测试基础设施

### 3.1 Test User Helpers

Helpers：

```text
createTestUser()
authHeadersFor(user)
createWorkspaceFor(user)
createThreadFor(workspace)
createRunFor(thread)
```

规则：

- helpers 创建隔离记录。
- 测试后清理。
- fixtures 不含个人信息。

### 3.2 Auth Test Helper

Route tests 需要一种不依赖真实浏览器登录的 protected API 测试方式。

选项：

- mock `requireUser()`
- 创建 Better Auth test session

建议：

- route tests 可以 mock auth helper。
- E2E tests 使用真实登录。

### 3.3 Fake Runner

在真实 agent runtime 前必须先有 fake runner。

模式：

```text
complete
fail
timeout
cancel-aware
file-write
artifact-create
source-record
```

Fake runner 必须：

- 在 sandbox 内运行，用于 integration tests。
- 调用 ingest APIs。
- 使用 scoped run token。
- 永远不直接访问数据库。

### 3.4 Fake LLM Proxy

Fake LLM proxy 用于稳定的 agent integration tests。

模式：

```text
tool-call-sequence
final-answer
timeout
error
```

### 3.5 Fixtures

必需 fixtures：

```text
fixtures/research/simple-topic.md
fixtures/workspace-files/notes.md
fixtures/artifacts/research-report.md
fixtures/sources/search-results.json
fixtures/sandbox-runner/fake-runner.ts
```

Fixture 规则：

- 无个人信息。
- 无私有 URL。
- 小而确定。

## 4. 按领域划分的测试矩阵

本节从"每个领域测哪几类"的提纲升级为具体测试名清单（[ADR-0018~0022](./decisions/README.md) 校订后的完整版本）。每条测试名都是可以直接拿去写 `it("...")`/`test("...")` 的断言点，不是话题标签。

### 4.1 Auth

Unit：

1. current user helper returns user when session valid
2. current user helper returns null when session missing
3. unauthenticated helper rejects with UNAUTHORIZED

Route：

4. `GET /api/me` unauthenticated -> 401
5. `GET /api/me` authenticated -> returns user only（不再返回 credits，见 ADR-0015）
6. protected route helper rejects request without Better Auth cookie
7. protected route helper passes through request with valid cookie

Integration（[ADR-0022](./decisions/0022-monorepo-hono-backend.md)）：

8. apps/api（Hono）能独立管理 Better Auth session，不依赖 apps/web
9. 本地开发下 apps/web 的 rewrite 代理能正确转发 auth cookie 到 apps/api

E2E：

10. register/login/logout
11. session persists across page refresh

### 4.2 Workspace

Unit：

1. title validation rejects empty string
2. title validation rejects whitespace-only string
3. title validation accepts non-empty trimmed string
4. archive policy: archived workspace blocks new thread/run creation
5. archive policy: archived workspace still readable

Route：

6. create workspace success
7. create workspace rejects empty title -> VALIDATION_FAILED
8. list only current user's workspaces
9. list excludes archived by default
10. list includes archived when query flag set
11. read workspace detail
12. update workspace title
13. archive workspace (soft delete)
14. user A cannot read user B's workspace -> FORBIDDEN or 404
15. user A cannot archive user B's workspace

Integration（[ADR-0018](./decisions/0018-atomic-state-transitions.md)）：

16. archived workspace rejects run creation via insert-select（0 行返回 WORKSPACE_ARCHIVED，不是先查后拒）
17. concurrent archive + create-run race: only one outcome wins, no partial state

### 4.3 Thread

Unit：

1. derive title from prompt when title omitted
2. derive title falls back to default when prompt empty
3. archive policy: archived thread blocks new run creation
4. archive policy: archived thread still readable

Route：

5. create thread inside workspace
6. create thread with explicit title
7. create thread with initialPrompt derives title
8. list threads inside workspace
9. read thread detail (includes messages and runs)
10. update thread title
11. archive thread
12. user A cannot access user B's thread -> FORBIDDEN or 404
13. cannot create thread inside another user's workspace

Integration：

14. thread detail includes messages and runs after real run completes
15. archived thread rejects run creation via insert-select（ADR-0018，同 workspace 的原子拒绝模式）

### 4.4 Run

Unit（state-machines.md §1/§2，含 [ADR-0019](./decisions/0019-waiting-for-input-state.md) 新状态）：

1. all legal RunStatus transitions succeed（含 running -> waiting_for_input）
2. all illegal RunStatus transitions rejected（如 created -> completed 直跳）
3. terminal status rejects any further transition
4. created/provisioning/running/waiting_for_input 都可以请求 cancel
5. timeout 可以收敛 provisioning/running/cancel_requested
6. waiting_for_input -> completed 转移合法（收尾场景，见 ADR-0019）
7. waiting_for_input -> interrupted 转移合法（sweep 兜底场景）
8. derived UI state maps correctly for each RunStatus，含 waiting_for_input -> waiting_for_input
9. derived UI state: stale heartbeat maps running -> possibly_running
10. derived UI state: terminal status ignores heartbeat staleness
11. derived UI state: waiting_for_input 不依赖 heartbeat 推导

Unit（[ADR-0018](./decisions/0018-atomic-state-transitions.md) `transitionRun` 辅助函数）：

12. transitionRun applies update when fromStatuses matches current status
13. transitionRun is no-op（0 行）when current status not in fromStatuses
14. transitionRun does not throw on no-op（并发场景下的另一方失败者路径）

Route：

15. create run success
16. create run rejects empty prompt -> VALIDATION_FAILED
17. read run detail（含 events/toolCalls/artifacts/sources）
18. cancel running run
19. cancel provisioning_sandbox run
20. cancel waiting_for_input run（ADR-0019）
21. cancel terminal run rejected -> RUN_NOT_CANCELABLE
22. cancel already cancel_requested run rejected（非法二次转移）

Integration：

23. create run starts fake runner
24. fake runner completes run -> status=completed, completedAt set
25. failed fake runner marks failed -> error message persisted
26. stale fake runner (heartbeat 过期) swept -> interrupted
27. stale provisioning_sandbox swept -> timeout
28. fake runner reports run_waiting_for_input -> status=waiting_for_input, sandbox 进程退出
29. creating new run on a thread with a waiting_for_input run first transitions old run to completed（ADR-0019 原子收尾）
30. waiting_for_input run untouched by sweep within 7-day threshold
31. waiting_for_input run past 7-day threshold swept to interrupted
32. concurrent sweep + fake runner completion race: only one transition wins, terminal status never overwritten（ADR-0018 核心验证点）
33. SandboxInstance currentRunId claimed atomically: two concurrent getOrCreate calls, only one gets the warm/ready instance, the other creates new（ADR-0018）
34. SandboxInstance currentRunId cleared when run reaches terminal or waiting_for_input

### 4.5 Events（含 [ADR-0020](./decisions/0020-agent-event-payload-schema-and-tool-retry.md) payload schema、[ADR-0021](./decisions/0021-token-stream-relay-redis-streams.md) stream chunk）

Unit：

1. seq monotonicity enforced within a run
2. duplicate same payload + same seq is idempotent (returns success, no duplicate row)
3. duplicate different payload + same seq is a conflict -> INGEST_SEQ_CONFLICT
4. partial ordering helper: run_created < sandbox_provisioning < sandbox_ready < agent_started
5. partial ordering helper: tool_call_started < tool_call_completed|tool_call_failed
6. partial ordering helper: artifact_started < artifact_created|artifact_failed
7. payload schema validates against type for each AgentEventPayloadMap key（每种 type 各一条，共 ~20 条断言，逐个类型循环生成）
8. payload validation rejects mismatched shape (e.g. tool_call_started payload missing toolCallId) -> VALIDATION_FAILED
9. agent_thinking/agent_message payload 不包含 tool call 字段（结构互斥验证）

Route：

10. ingest event with valid token
11. reject ingest without token -> 401
12. reject token for wrong run -> RUN_TOKEN_INVALID
13. terminal run rejects new event -> RUN_TERMINAL
14. waiting_for_input run rejects new ordinary event（除自身触发的那一条）
15. ingest run_waiting_for_input event -> run transitions to waiting_for_input
16. ingest artifact_updated event requires existing artifactId
17. ingest heartbeat with phase field persists Run.lastHeartbeatAt and phase

Route（[ADR-0021](./decisions/0021-token-stream-relay-redis-streams.md) stream chunk）：

18. POST /api/ingest/stream-chunk accepts chunk for active run
19. POST /api/ingest/stream-chunk rejects chunk for terminal run
20. stream chunk does not create an AgentEvent row（转发路径不落库验证）
21. stream chunk XADD immediately readable via XREAD（毫秒级验证）

SSE：

22. snapshot includes existing (historical) events
23. active run streams new events as they're ingested
24. terminal run sends done after snapshot
25. waiting_for_input run sends snapshot（含 waitingForInput 字段）then done
26. reconnect with Last-Event-ID resumes from correct cursor, no duplicate delivery
27. reconnect with Last-Event-ID resumes from correct cursor, no lost chunk（ADR-0021 核心验证点，模拟建连竞态和重连空洞两个场景）
28. new connection without Last-Event-ID reads full stream from start (cursor "0")

### 4.6 Sandbox（含 [ADR-0018](./decisions/0018-atomic-state-transitions.md) 复用互斥、[ADR-0019](./decisions/0019-waiting-for-input-state.md) warm 释放）

Unit：

1. sandbox name generation is deterministic and workspace-scoped
2. provider state conversion (SandboxStatus <-> provider raw state)

Integration：

3. create sandbox（首次，无 warm/ready 可复用）
4. resume sandbox from stopped state
5. resume sandbox from warm/ready state（复用，不重建）
6. start fake runner inside sandbox
7. runner has no DB env vars present
8. runner has no Better Auth cookie present
9. runner can call ingest with scoped run token
10. runner can be cancelled mid-execution
11. concurrent getOrCreate requests: only one claims a warm/ready instance（currentRunId 原子认领，ADR-0018）
12. run entering waiting_for_input releases SandboxInstance to warm（currentRunId 清空，ADR-0019）
13. next run on same workspace reuses the released warm instance
14. orphan SandboxInstance（warm/ready 但无活跃 run）swept and stopped（ADR-0015 扩大的 sweep 范围）

### 4.7 Files

Unit：

1. path guard rejects path traversal (`../`, absolute paths outside root)
2. path guard normalizes valid relative paths
3. content hash computed consistently for same content
4. content size policy rejects oversized inline content -> falls back to storageKey requirement

Route：

5. ingest file metadata
6. ingest small text content (inline)
7. ingest large content requires storageKey
8. reject path traversal -> VALIDATION_FAILED
9. upsert by (workspaceId, path) — second ingest updates, not duplicates
10. list files in workspace
11. read file content by path
12. reject another user's workspace file access -> FORBIDDEN

Integration：

13. fake runner writes workspace file, ingest persists metadata
14. file survives refresh/API reload (read from DB, not sandbox memory)
15. file_written event correlates with WorkspaceFile via eventSeq

### 4.8 Artifacts（含 [ADR-0020](./decisions/0020-agent-event-payload-schema-and-tool-retry.md) 版本判定规则）

Unit：

1. artifact validation requires title/kind
2. artifact validation requires recoverable content (contentSnapshot/storageKey/valid file path)
3. version allocation: missing/unknown artifactId -> version=1
4. version allocation: existing artifactId -> version+1（原子递增，ADR-0018 原则）
5. content snapshot requirement rejects artifact with none of contentSnapshot/storageKey/path

Route：

6. ingest artifact (first create) -> artifact_created event
7. ingest artifact (existing artifactId) -> artifact_updated event, version incremented
8. list artifacts in workspace
9. get artifact detail (含 sources)
10. get artifact versions -> returns array length 1 for single-version artifact
11. get artifact versions -> returns all versions after multiple updates
12. get artifact download -> content or downloadUrl, exactly one present
13. reject artifact without recoverable content -> VALIDATION_FAILED
14. user A cannot read user B's artifact -> FORBIDDEN

Integration：

15. fake runner creates artifact
16. fake runner updates same artifact -> new version, old version still readable
17. artifact remains readable after related workspace file changes
18. artifact detail response includes referencing sources

### 4.9 Sources

Unit：

1. source kind validation (url/file/command/search_result/manual)
2. URL normalization (trailing slash, protocol casing) if implemented

Route：

3. ingest source
4. ingest source referencing an artifactId
5. list workspace sources
6. list run sources
7. artifact source references appear in artifact detail

Integration：

8. fake runner records URL source via fetch_url, artifact references it
9. fake runner records search_result source via web_search（ADR-0020）

### 4.10 LLM Proxy（含 [ADR-0009](./decisions/0009-provider-anti-corruption-layer.md)/[ADR-0017](./decisions/0017-token-accumulation-and-persistence-timing.md) finish_reason 归一化）

Unit：

1. model config resolution (modelHint -> concrete model)
2. missing key behavior: no provider key configured -> clear error, not silent fallback
3. finish_reason normalization: maps differing provider signals to a stable internal value

Route：

4. reject missing token -> 401
5. reject wrong run token -> RUN_TOKEN_INVALID
6. reject terminal run -> RUN_TERMINAL
7. fake provider success returns model output
8. usage recorded as LLMUsageRecord (provider/model/tokens/durationMs)（不是 credit debit，见 ADR-0015）
9. streaming response chunks forwarded to sandbox in order

Integration：

10. sandbox runner calls fake LLM proxy, receives streamed tokens
11. sandbox runner forwards tokens via stream-chunk while accumulating in memory（ADR-0017 攒批路径验证）
12. sandbox runner ingests agent_thinking event only after finish_reason/语义边界信号出现

Smoke（缺 credentials 时 skip，注明原因）：

13. real provider returns response

### 4.11 Search Proxy（新增，[ADR-0020](./decisions/0020-agent-event-payload-schema-and-tool-retry.md)，解决 DQ-3）

Route：

1. reject missing token -> 401
2. reject terminal run -> RUN_TERMINAL
3. fake provider returns normalized results (url/title/snippet)
4. retries on 5xx up to 2 times with backoff
5. does not retry on 4xx -> SEARCH_PROXY_FAILED
6. usage recorded as LLMUsageRecord

Integration：

7. sandbox runner calls fake search proxy via web_search tool
8. results become Source records (kind=search_result)

### 4.12 Tools: web_search / fetch_url（新增，[ADR-0020](./decisions/0020-agent-event-payload-schema-and-tool-retry.md)）

Unit：

1. fetch_url SSRF guard rejects localhost/127.0.0.1
2. fetch_url SSRF guard rejects private CIDR ranges (10.x/172.16.x/192.168.x/169.254.x)
3. fetch_url SSRF guard rejects cloud metadata addresses
4. fetch_url rejects non-http/https schemes
5. fetch_url truncates content over size limit, marks truncated=true
6. fetch_url skips full parse for non-text content-type, records metadata only

Integration（fake network layer）：

7. fetch_url succeeds on first try -> ToolCall completed
8. fetch_url retries once on network failure then succeeds -> completed
9. fetch_url exhausts retry then fails -> ToolCall failed (not rejected)
10. fetch_url SSRF guard triggers -> ToolCall rejected (not failed)
11. fetch_url always records a Source(kind=url) regardless of eventual use
12. web_search succeeds -> ToolCall completed, results as Sources
13. web_search retries up to 2 times on 5xx then succeeds
14. web_search 4xx does not retry -> ToolCall failed

### 4.13 Usage（原 Credits，[ADR-0015](./decisions/0015-usage-telemetry-and-ops-priorities.md) 改为用量遥测）

Route：

1. list own usage records only
2. filter by runId
3. filter by provider/model
4. pagination works with default and custom page size

Integration：

5. run with LLM proxy calls produces LLMUsageRecord entries
6. run with search proxy calls produces LLMUsageRecord entries
7. no run is ever rejected due to usage/balance（负向验证：确认 INSUFFICIENT_CREDITS 路径已被移除）

### 4.14 Frontend

Component：

1. app shell renders with mocked user, workspaces, threads
2. sidebar highlights active workspace/thread
3. composer disabled during running/possibly_running/cancelling
4. composer enabled + shows question prompt during waiting_for_input（ADR-0019）
5. composer enabled after terminal states
6. cancel button shown during active run, hidden during waiting_for_input
7. run event rendering: agent_thinking/agent_message distinguished from tool_call events
8. artifact preview card renders on artifact_created/artifact_updated
9. artifact panel opens on preview click, shows correct version
10. artifact panel shows version footer with version switcher
11. mobile artifact overlay renders full-screen

Hook：

12. useComposerEnabled returns correct boolean per derivedUiState（ADR-0019 共享 hook，桌面+移动共用同一断言集）
13. load workspace state
14. load thread state
15. merge SSE events into active run state
16. SSE reconnect resumes from Last-Event-ID without duplicate render（ADR-0021）
17. open/close artifact panel state

E2E：

18. full fake-runner happy path（含 Stage1 概览 -> waiting_for_input -> 用户选择 -> Stage2 深挖，见 ADR-0013/0019）
19. cancel path
20. reconnect after network drop resumes without visible data loss

## 5. API Happy Path Test

必须有一个 integration test 证明：

```text
1. create/authenticate user
2. create workspace
3. create thread
4. create run（不再有 reserve credits 步骤，见 ADR-0015）
5. provision sandbox（认领 SandboxInstance 原子 UPDATE，见 ADR-0018）
6. fake runner posts heartbeat（含 phase 字段）
7. fake runner posts events
8. fake runner posts stream-chunk（token 转发，验证不落库，见 ADR-0021）
9. fake runner ingests file
10. fake runner ingests source
11. fake runner ingests artifact（首次创建，version=1）
12. fake runner ingests run_waiting_for_input（Stage1 概览完成，见 ADR-0019）
13. GET run returns status=waiting_for_input with question payload
14. POST new run on same thread first transitions old run to completed
15. fake runner (Stage2) ingests artifact with same artifactId -> version=2, artifact_updated event
16. fake runner completes Stage2 run
17. GET run returns terminal status and events
18. GET files returns workspace file
19. GET artifacts returns artifact with 2 versions
20. GET usage/records returns LLMUsageRecord entries（不是 credits ledger，见 ADR-0015）
21. SSE snapshot can recover final state
22. SSE reconnect with Last-Event-ID resumes token stream without loss（ADR-0021）
```

这条测试是 UI 开发前的后端契约。

## 6. Failure Path Tests

必测失败流程：

```text
unauthenticated request
cross-user workspace access
archived workspace/thread rejects run creation（ADR-0018 原子拒绝）
invalid run transition
concurrent run transitions race（ADR-0018，只有一次生效）
duplicate ingest seq
event payload shape mismatch（ADR-0020）
wrong run token
expired run token
sandbox provisioning failure
sandbox claim conflict（ADR-0018，并发抢同一个 warm 实例）
LLM proxy failure
search proxy failure（ADR-0020）
tool rejected（policy/SSRF guard）
tool failed（网络重试耗尽）
tool timeout
runner crash
run timeout
run stuck in waiting_for_input past threshold（ADR-0019）
cancel active run
cancel waiting_for_input run
terminal run ingest
stream-chunk on terminal run
```

## 7. 测试命名

使用描述性测试名：

```text
rejects cross-user workspace access
marks stale running run as interrupted
creates artifact from sandbox ingest with content snapshot
creates artifact_updated event when artifactId already exists
transitions run to waiting_for_input without marking it stuck
only one of two concurrent transitionRun calls succeeds
rejects fetch_url request targeting private CIDR range
does not record duplicate usage on repeated LLM proxy retry
```

避免模糊命名：

```text
works
handles error
test run
```

## 8. 质量门禁

monorepo 重构后（[ADR-0022](./decisions/0022-monorepo-hono-backend.md)），以下命令默认在仓库根用 pnpm workspace 过滤器按需跑单个 app/package（如 `pnpm --filter api test`），也可以在根目录跑全量。具体脚本命名留给 Phase 0.5 落地时定义，这里给出的是命令意图，不是最终精确 flag。

默认本地门禁：

```bash
pnpm test
pnpm build
```

Phase 完成前：

```bash
pnpm test
pnpm test:integration
pnpm build
```

UI phase merge 前：

```bash
pnpm test
pnpm build
pnpm e2e
```

Lint：

```bash
pnpm lint
```

如果 lint 暂时不干净，必须记录明确的已知失败和修复计划，不要让 lint failure 保持模糊。

## 9. Skip 测试规则

允许 skip 的原因：

- 缺少外部 credentials
- 明确是 P1 feature
- flaky external provider smoke test

每个 skip 都必须在测试名或注释里说明原因。

不允许：

- skip deterministic unit 或 route tests
- 因为实现麻烦而 skip

## 10. 测试数据清理

规则：

- 测试记录使用确定性 prefix。
- 测试清理自己创建的记录。
- integration tests 不删除无关远端数据。
- test user identity 使用中性信息。
- fixtures 不包含个人信息。


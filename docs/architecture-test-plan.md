# 架构分层测试计划

这份文档用于重新掌控 v2 后端系统的开发节奏。它不替代：

- [testing-philosophy.md](./testing-philosophy.md)：测试理念和判断标准。
- [testing-strategy.md](./testing-strategy.md)：测试层级、环境、命令。
- [testing-case-catalog.md](./testing-case-catalog.md)：具体 case ID 和落地状态。

本文件回答三个问题：

1. 这个系统按架构应该拆成哪些模块。
2. 每个模块应该怎么独立测试。
3. 模块之间按什么顺序对接，什么时候才允许进入完整链路。

规则：

- 从小范围开始：模块内测试先绿，再测相邻模块，再测完整 workflow/live。
- 每一部分只在测试计划、测试用例、自动化测试都能解释清楚后才进入下一部分。
- 不用完整链路成功替代模块验收。
- 前端只消费事件和事实，不用前端结果反推后端正确。

## 1. 架构模块

当前系统按责任边界拆成六层：

| 顺序 | 模块 | 责任 | 不负责 |
| --- | --- | --- | --- |
| 1 | Control Plane | 鉴权、状态机、事实源、事件、ingest、SSE API、调度入口 | 不执行 bash，不直接跑 agent 推理 |
| 2 | Sandbox Substrate | 创建/复用/停止 Vercel Sandbox，读写文件，执行命令，环境隔离 | 不理解产品语义，不写业务 DB |
| 3 | Runtime Tools | Pi runtime 内的 read/write/list/run/search/fetch/artifact 工具协议 | 不拥有长期 secret，不直接连 DB/Redis |
| 4 | Redis Streaming | content/thinking chunk 的瞬时流、cursor、重连、清理 | 不存业务事实，不替代 RunEvent |
| 5 | Workspace Mapping | DB WorkspaceFile/Artifact 与 sandbox `/workspace` 的同步和回写边界 | 不把所有临时文件都当用户资产 |
| 6 | End-to-End Product Path | hosted API + real sandbox + real runtime + provider + frontend | 不用于发现基础模块契约 |

## 2. 推进顺序

每个模块遵循同一个收敛顺序：

```text
契约文档 -> unit/route tests -> component integration -> 相邻模块 workflow -> live/release gate
```

禁止跳级：

- Sandbox 没有独立 exec/path/env 测试前，不用 runtime workflow 证明 sandbox 安全。
- Runtime tools 没有独立工具测试前，不用 live provider 成功证明工具协议正确。
- Redis stream 没有 cursor/reconnect 测试前，不用浏览器看起来在动证明流式正确。
- Workspace mapping 没有水合/回写测试前，不说“workspace 文件系统完成”。

## 3. 模块验收模板

每个模块必须回答：

| 问题 | 必须产物 |
| --- | --- |
| 输入是什么 | API body / config / tool args / env contract |
| 输出是什么 | response DTO / DB row / Redis entry / SSE event |
| 状态机是什么 | legal transitions、terminal、并发赢家 |
| 事实源在哪里 | Postgres / Redis / sandbox fs / provider response |
| 失败怎么表现 | error code、tool status、run status、SSE event |
| 如何观测 | DB 查询、SSE、logs、usage record、tool call |
| 如何清理 | test data prefix、sandbox stop、Redis TTL |

一个模块算完成，必须满足：

- happy path 有自动化测试。
- 至少一个失败路径有自动化测试。
- 权限或边界条件有自动化测试。
- 文档能解释该模块“不负责什么”。
- 测试失败时能定位是模块内问题，而不是完整链路黑盒问题。

## 4. Part 1: Control Plane

Control Plane 指 `apps/api` 里的 Hono 后端控制层。它是事实源和状态机，不是 UI 面板。

### 4.1 范围

Control Plane 负责：

- Auth / session / ownership。
- Workspace / Thread / Run 基础 API。
- Run state machine。
- RunEvent event store。
- RunToolCall store。
- Ingest 鉴权和 scoped run token。
- WorkspaceFile / Artifact / Source 的持久事实。
- SSE snapshot/live/reconnect API。
- LLM/Search proxy 的服务端边界。
- Sweep / cleanup 入口。

Control Plane 不负责：

- 在本机执行 bash。
- 在 sandbox 内执行工具。
- 决定 LLM 自然语言内容是否“好”。
- 将前端状态当事实源。

### 4.2 测试方法

Control Plane 分四层测。

#### Unit

用于纯逻辑：

- validation。
- DTO conversion。
- state transition。
- path guard。
- token signing/parsing。
- event payload schema。
- retry/backoff policy 的纯函数部分。

命令：

```bash
pnpm test
```

#### Route / Integration

用于 API contract 和 DB 事实：

- Hono app 进程内请求。
- 真实 Neon test rows。
- 真实 Redis 可用于 stream 相关测试。
- 不启动真实 Pi runtime。
- 不依赖真实 LLM。

命令：

```bash
pnpm test:integration
```

#### Control Plane Workflow

用于验证多个 Control Plane 子模块组合：

- create workspace/thread/run。
- ingest events/tool calls/files/artifacts。
- SSE snapshot/replay。
- sweep 收敛。

这里仍然不应该让真实 provider 成为 oracle。

命令：

```bash
CAP_API_BASE_URL=https://api.sandbox.maidang.me pnpm test:workflow
```

#### Live

只验证 hosted runtime 差异：

- Vercel serverless runtime。
- CORS/cookie。
- deployed API base URL。
- public callback URL。

命令：

```bash
CAP_API_BASE_URL=https://api.sandbox.maidang.me pnpm --dir apps/api test:live
```

### 4.3 Control Plane 用例清单

状态：

```text
planned    已列入，未必已有自动化测试
existing   现有测试大概率覆盖，需要复核并映射 case ID
gap        已知缺口，需要新增或改测试
```

#### CP-AUTH

| ID | 层级 | 用例 | Oracle | 状态 | 测试文件 |
| --- | --- | --- | --- | --- | --- |
| CP-AUTH-001 | integration | sign-up / sign-in / get-session | session cookie + user DTO | existing | `auth.integration.test.ts`："注册新用户成功...设置 session cookie"、"已存在账号可以用邮箱密码登录"、"带合法 session cookie 查询 get-session 返回当前用户" |
| CP-AUTH-002 | integration | bad password / duplicate email | stable error envelope | existing | `auth.integration.test.ts`："错误密码登录被拒绝"、"重复邮箱注册被拒绝" |
| CP-AUTH-003 | integration | unauthenticated protected API | 401 + `{code,message,data:null}` | existing | `me.integration.test.ts`："未登录返回 401" |
| CP-AUTH-004 | integration | invalid cookie | 401, no user leak | existing | `me.integration.test.ts`："过期/无效 cookie 视为未登录，返回 401" |

#### CP-OWNERSHIP

| ID | 层级 | 用例 | Oracle | 状态 | 测试文件 |
| --- | --- | --- | --- | --- | --- |
| CP-OWN-001 | integration | user cannot read another workspace | 404/403 policy result, no data leak | existing | `workspace/routes.integration.test.ts`："user A cannot read user B's workspace -> 404"、"user A cannot archive user B's workspace" |
| CP-OWN-002 | integration | user cannot list another thread/files/artifacts/sources | stable forbidden/not found envelope | existing（已补子资源覆盖） | `thread/routes.integration.test.ts`："user A cannot access user B's thread -> 404"；`files/routes.integration.test.ts`："rejects another user's workspace file access"、"rejects another user's workspace file content access"；`artifacts/routes.integration.test.ts`："user A cannot read user B's artifact"、"user A cannot list, version, or download user B's artifacts"；`sources/routes.integration.test.ts`："rejects another user's source list access" |
| CP-OWN-003 | integration | run detail requires owning user | no cross-user run/tool/artifact leak | existing（已补 SSE/usage 边界覆盖） | `run/routes.integration.test.ts`："user B cannot read or cancel user A's run -> 404"；`run/event-sse.integration.test.ts`："rejects another user's SSE request without leaking snapshot data"；`usage/routes.integration.test.ts`："filter by another user's runId returns no usage records" |
| CP-OWN-004 | integration | scoped run token cannot write another run | 401 run token invalid | existing | `run/run-token.test.ts`："rejects token for the wrong run"、"rejects token for the wrong workspace"；`ingest/routes.integration.test.ts`："reject token for wrong run -> RUN_TOKEN_INVALID" |

#### CP-RUN-STATE

| ID | 层级 | 用例 | Oracle | 状态 | 测试文件 |
| --- | --- | --- | --- | --- | --- |
| CP-RUN-001 | unit | legal run transitions | transition matrix accepts expected edges | existing | `run/transitions.test.ts`："all legal RunStatus transitions succeed（含 running -> waiting_for_input）" |
| CP-RUN-002 | unit | illegal run transitions | transition matrix rejects invalid edges | existing | `run/transitions.test.ts`："all illegal RunStatus transitions rejected（如 created -> completed 直跳）" |
| CP-RUN-003 | integration | concurrent transition only one winner | one DB row update succeeds | existing | `run/transition-run.integration.test.ts`："concurrent transitionRun calls: only one succeeds, terminal status never overwritten" |
| CP-RUN-004 | integration | terminal state cannot be overwritten | completed/failed/cancelled stable | existing | `run/transitions.test.ts`："terminal status rejects any further transition"；`run/routes.integration.test.ts`："cancel terminal run rejected -> RUN_NOT_CANCELABLE" |
| CP-RUN-005 | integration | cancel created/provisioning/running/waiting states | correct terminal or cancel_requested behavior | existing | `run/routes.integration.test.ts`："cancel running run"、"cancel provisioning_sandbox run"、"cancel waiting_for_input run（ADR-0019）" |
| CP-RUN-006 | integration | create run rejects archived thread/workspace | no AgentRun row created | existing | `run/routes.integration.test.ts`："archived thread rejects run creation via insert-select（ADR-0018）" |

#### CP-EVENT-STORE

| ID | 层级 | 用例 | Oracle | 状态 | 测试文件 |
| --- | --- | --- | --- | --- | --- |
| CP-EVT-001 | unit | event payload schema validation | bad payload rejected before DB | existing | `run/event-store.test.ts`："payload schema validates against every AgentEventPayloadMap key"、"rejects mismatched shape -> VALIDATION_FAILED" |
| CP-EVT-002 | integration | ingest event with seq writes exactly once | one RunEvent row | existing | `run/event-store.integration.test.ts`："seq monotonicity enforced within a run" |
| CP-EVT-003 | integration | same seq same payload idempotent | idempotent response, no duplicate | existing（已补并发覆盖，见下方说明） | `run/event-store.integration.test.ts`："duplicate same payload + same seq is idempotent and creates no duplicate row"（串行）、"concurrent insertRunEvent with same seq + same payload: exactly one row, both calls report ok"（真并发，`Promise.all` 两次同时调用） |
| CP-EVT-004 | integration | same seq different payload conflict | 409 conflict | existing（已补并发覆盖，见下方说明） | `run/event-store.integration.test.ts`："duplicate different payload + same seq is a conflict -> INGEST_SEQ_CONFLICT"（串行）、"concurrent insertRunEvent with same seq + different payload: exactly one succeeds, the other is INGEST_SEQ_CONFLICT"（真并发） |
| CP-EVT-005 | integration | terminal run rejects new event | 409 run terminal | existing | `ingest/routes.integration.test.ts`："terminal run rejects new event -> RUN_TERMINAL" |

**复核过程中发现并修复的并发 bug（2026-07-09）**：CP-EVT-003/004 原本的测试只串行调用 `insertRunEvent` 两次，从未用 `Promise.all` 真正并发调用过。补上并发测试后，在真实 Neon 上直接触发了两个此前未被发现的 bug：

1. `event-store.ts` 里 `input.seq <= maxSeq` 的判断（应为 `<`）会让并发下"同 seq 同内容"的合法重试被误判为 `INGEST_SEQ_CONFLICT`，而不是按预期走幂等分支。
2. `isUniqueConstraintError` 用 `isPlainObject` 判断 Prisma 抛出的异常，但真实的 `PrismaClientKnownRequestError` 是类实例、不是字面量对象，判断恒为 `false`——数据库唯一约束冲突时，代码会把异常直接抛给调用方，而不是走设计好的幂等/冲突判断兜底。

两处已修复（`<=` 改 `<`；`isUniqueConstraintError` 改用 `instanceof Prisma.PrismaClientKnownRequestError`），`pnpm test`（128）、`pnpm test:integration`（167，含新增 2 条）全绿。这条记录留在这里是为了以后不要误以为"existing"就等于"并发路径也测过"——同样的检查方式应该在后续复核 Control Plane 其他"先查后写"式代码（例如 artifact 版本号分配、`RunToolCall` 状态转移）时重复做一遍。

#### CP-TOOL-CALL

| ID | 层级 | 用例 | Oracle | 状态 | 测试文件 |
| --- | --- | --- | --- | --- | --- |
| CP-TOOL-001 | integration | tool call running -> completed | RunToolCall row updated | existing（已补并发覆盖，见下方说明） | `ingest/routes.integration.test.ts`："records tool call pending -> running -> completed"、"concurrent terminal reports on the same running tool call: last write wins instead of exactly one applying"（真并发） |
| CP-TOOL-002 | integration | tool call running -> failed/rejected/timeout | status/error persisted | existing | `ingest/routes.integration.test.ts`："records running -> failed and running -> rejected distinctly" |
| CP-TOOL-003 | integration | invalid tool transition rejected | 409 invalid transition | existing | `ingest/routes.integration.test.ts`："terminal tool call cannot later be completed" |
| CP-TOOL-004 | integration | tool call id from another run rejected | 401 run token invalid | gap（无用例，见下）| 无现有测试对 `/api/ingest/tool-calls` 专门验证跨 run 复用同一 `toolCallId` 的场景；`apps/api/src/ingest/routes.ts:208-209` 已实现该拒绝逻辑（`existing.runId !== run.id` -> 401 `run token invalid`），只是缺自动化用例，不是实现缺口 |
| CP-TOOL-005 | workflow | tool lifecycle appears in SSE timeline | `tool_call_started/completed/failed` events visible | existing（2026-07-10 补齐） | `ingest/routes.integration.test.ts`："records tool call pending -> running -> completed" 断言 `tool_call_started`/`tool_call_completed`；"records running -> failed and running -> rejected distinctly" 断言 `tool_call_failed`；`sandbox/scripted-ingest-fixture.integration.test.ts`："scripted ingest fixture completes run through ingest HTTP" |
| CP-TOOL-006 | workflow | failed tool maps to run policy | run failed/interrupted/can continue according to policy | planned | 无现有测试，暂不在本轮范围 |

**复核过程中发现并修复的并发 bug（2026-07-10）**：`POST /api/ingest/tool-calls` 的 `existing -> update` 分支之前是 `prisma.runToolCall.update({ where: { id: existing.id }, ... })`——只用 `id` 做 `where`，没有像 `transitionRun`（ADR-0018）那样带上"当前状态必须还是刚读到的 existing.status"这个条件。两个并发的终态上报（例如同一个 `run_command` 调用，一个上报 `completed`、一个上报 `failed`）会各自读到相同的 `existing.status === "running"`，都通过 `isLegalToolCallTransition` 检查，然后都无条件写入成功——用一条新增的并发测试实测验证过：修复前两次请求都返回 `200`，最终状态由"最后落盘的那次"决定，跟两次调用实际发生的时间顺序无关，且没有任何错误或日志能暴露这次竞态。这是静默数据损坏，比 CP-EVT-003/004 那两个 bug 更隐蔽（那两个至少会抛异常或返回明确的冲突码）。

修复：改成 `prisma.runToolCall.updateMany({ where: { id: existing.id, status: existing.status }, ... })`，受影响行数为 0 时统一按 409 `invalid tool call transition` 处理（不区分"从一开始就非法"还是"合法但输给了并发的另一方"，调用方不需要关心这个区别）。修复后同一条测试实测两次并发请求恰好一个 200、一个 409。`pnpm test`（128）、`pnpm test:integration`（168，含新增 1 条）全绿。

同样的检查（"where 里有没有带上当前状态条件，而不是只用 id"）还应该在后续复核 artifact 版本号分配（`updateArtifactVersion`）等其他"先查后写"式代码时重复做——这是第二次在 Control Plane 里发现这类模式的并发漏洞，值得当成一类系统性问题排查，而不是逐个孤立事件。

**复核过程中判断错误并已撤回的改动（2026-07-10）**：复核 `createRunIfThreadActive`（`run/create.ts`）时，发现前端 `composer.tsx` 的 `canSubmit` 逻辑禁止在有活跃 run 时提交新 run（`!isRunActive(run)`），但后端的 insert-select 没有任何检查"这个 thread 上是否已存在非终态 run"。当时判断这是一个后端遗漏强制的产品规则，改了 `createRunIfThreadActive` 加上 `NOT EXISTS` 子查询，阻止同一 thread 出现第二个非终态 run。

这个判断错了，已经用 `git checkout` 撤回。跑现有测试套件后发现 67 个测试失败——`run/routes.integration.test.ts`、`usage/routes.integration.test.ts` 等大量测试文件里，同一个 thread 被多个独立 `it` 用例反复复用，各自创建新 run 用于测试不同场景，这些 run 在测试环境下不会自然走到终态。进一步查 `openspec/changes/v2-research-workspace-agent/specs/run-lifecycle/spec.md` 和 `docs/decisions/0019-waiting-for-input-state.md`，确认产品设计本来就是"同一个 thread 内允许多个连续 run"（ADR-0013 的 Stage1/Stage2 机制深挖模型：Stage1 和 Stage2 是同一个 thread 下两个独立的 run），且规格文档里除了 `waiting_for_input` 这一个特定状态的收尾规则外，没有任何地方定义过"同一 thread 同时只能一个非终态 run"这样的一般性数据库约束。

结论：`composer.tsx` 里的 `!isRunActive(run)` 是 UI 层面防止用户重复提交的交互细节，不是数据一致性约束——两个同时存在的 Run 记录不会互相破坏数据，跟前面三次真正的并发 bug（同一行数据被并发写坏）性质不同。是否要在数据库层面处理"多标签页/多设备同时提交"这类场景，属于产品设计决策，不是这轮并发安全复核的范围，本文档不再把它当作一个待修的缺口。这次教训：这一处是本轮唯一一次在没有先写测试探明现状的情况下就直接改了生产代码，直接导致大范围测试回归——后续任何"看起来像缺口"的判断，都必须先补一条验证现状的测试，而不是凭一次读代码的印象下结论。

#### CP-FILES-ARTIFACTS-SOURCES

| ID | 层级 | 用例 | Oracle | 状态 | 测试文件 |
| --- | --- | --- | --- | --- | --- |
| CP-FILE-001 | integration | ingest text file | WorkspaceFile row + content hash | existing | `files/routes.integration.test.ts`："ingests small text content inline"、"ingests file metadata with storageKey" |
| CP-FILE-002 | unit/integration | path traversal rejected | no row, validation error | existing | `files/routes.integration.test.ts`："rejects path traversal"；`files/store.test.ts`（path guard 单元测试） |
| CP-FILE-003 | integration | directory kind rejects content/storageKey | validation error | existing | `files/routes.integration.test.ts`："large content requires storageKey" |
| CP-ART-001 | integration | create artifact | WorkspaceArtifact version 1 + artifact_created | existing（已补并发防御，见下方说明） | `artifacts/routes.integration.test.ts`："ingests artifact first create and writes artifact_created event"、"concurrent create with the same client-supplied artifactId: exactly one create succeeds, the other reports a clear conflict instead of crashing"（真并发） |
| CP-ART-002 | integration | update artifact | version increments + artifact_updated | existing | `artifacts/routes.integration.test.ts`："ingests artifact update and writes artifact_updated event with incremented version" |
| CP-ART-003 | integration | artifact path resolves file content | contentSnapshot recoverable | existing | `artifacts/routes.integration.test.ts`："extracts content snapshot from a valid workspace file path" |
| CP-SRC-001 | integration | source ingest and artifact linkage | Source row + references | existing | `sources/routes.integration.test.ts`："ingests source referencing an artifact and writes source_recorded event" |

**复核过程中发现并修复的并发风险（2026-07-10）**：`POST /api/ingest/artifacts` 的 `existing = findUnique(...)；existing ? updateArtifactVersion : createFirstArtifact` 判断（`ingest/routes.ts`）不在任何事务或条件 UPDATE 里保护。`createFirstArtifact` 用调用方传入的 `artifactId`（Pi runtime `create_artifact` 工具可以自带）当 `WorkspaceArtifact` 主键 `create()`；如果两个并发请求带着同一个 `artifactId` 都读到 `existing === null`，两边都会走 `create()`，其中一个必然撞主键唯一约束，且原本没有 catch，异常会直接抛出到调用方，变成未处理的 500。

这次和 CP-EVT/CP-TOOL 那两次不同的地方：追查后发现当前产品配置下这个场景**没有已知的活跃触发路径**——Pi runtime 工具调用是严格串行执行的（`toolExecution: "sequential"`，见 `pi-runtime/agent.ts`），且 `control-plane-client.ts` 的 `postJson` 没有客户端自动重试，所以同一个 `artifactId` 不会自然地被两个并发请求同时提交。也就是说这是一个**设计上的脆弱点，不是当前活跃的 bug**——一旦以后打开并行工具执行、加了客户端重试、或者有别的调用方直接打这个 ingest 端点，这个脆弱点就会变成真实故障。已经按防御性原则提前修复：复用 `event-store.ts` 里判断真实 Prisma `P2002` 异常的 `isUniqueConstraintError`（该函数已在 CP-EVT 那次修复中改成用 `instanceof Prisma.PrismaClientKnownRequestError` 判断，这次导出复用，不重复造轮子），`createFirstArtifact` 外层 catch 住这个异常后返回 `409 { code: 2005 }`（`INVALID_STATE_TRANSITION`，语义是"这次请求输给了并发的另一方，应该改走 update 路径"），而不是让异常穿透。补的并发测试用 `Promise.all` 强制制造这个原本达不到的场景，验证修复：恰好一个 200、一个 409，`WorkspaceArtifact` 表最终只有一行。`pnpm test`（128）、`pnpm test:integration`（169，含新增 1 条）全绿。

`updateArtifactVersion`（既有 artifact 的版本递增）单独复核过，判定为安全：`version: { increment: 1 }` 编译成数据库原生的 `SET version = version + 1`，且整个函数包在 `prisma.$transaction` 里，Postgres 对 `UPDATE` 语句的行锁会让并发事务互相排队，不存在"两个事务都读到旧版本号、都算出同一个新版本号"的竞态——这一层不需要改。

#### CP-SSE-REDIS-BOUNDARY

| ID | 层级 | 用例 | Oracle | 状态 | 测试文件 |
| --- | --- | --- | --- | --- | --- |
| CP-SSE-001 | integration | snapshot contains run/events/toolCalls/artifacts/sources shape | stable DTO | existing | `run/event-sse.integration.test.ts`："snapshot includes existing historical events"、"POST SSE snapshot includes existing historical events" |
| CP-SSE-002 | integration | live DB events stream until terminal done | event order + done | existing | `run/event-sse.integration.test.ts`："active run streams new events as they're ingested"、"terminal run sends done after snapshot" |
| CP-SSE-003 | integration | Redis stream chunk cursor `0` replay + isolated blocking reader | no lost chunk or writer head-of-line blocking | existing | `run/event-sse.integration.test.ts`：'new connection without Last-Event-ID reads full stream from start (cursor "0")'；`redis/stream-chunk.integration.test.ts`：cursor replay + "publishes immediately while an isolated stream reader is blocked" |
| CP-SSE-004 | integration | Last-Event-ID resume | no duplicate/no lost chunk | existing | `run/event-sse.integration.test.ts`："reconnect with Last-Event-ID resumes from correct cursor, no duplicate delivery"、"reconnect with Last-Event-ID resumes through reconnect gap, no lost chunk" |
| CP-SSE-005 | workflow | tool call lifecycle merged into SSE timeline | tool events visible in order | existing（2026-07-10 补齐） | `run/event-sse.integration.test.ts`："snapshot includes tool call lifecycle events"；`ingest/routes.integration.test.ts` 已验证真实 ingest 会生产 `tool_call_started/completed/failed` |
| CP-SSE-006 | workflow | content chunk arrives before final agent_message | stream chunk before semantic event | existing（复核后改为 existing，归属见 §4.4b） | `agent-loop/agent-loop.workflow.test.ts`："streams LLM chunks to Redis before semantic events are persisted"（等同 `testing-case-catalog.md` 的 `AGENT-W-002`） |

#### CP-PROXY

| ID | 层级 | 用例 | Oracle | 状态 | 测试文件 |
| --- | --- | --- | --- | --- | --- |
| CP-LLM-001 | integration | LLM proxy auth and run-token scope | unauthorized rejected | existing | `llm/routes.integration.test.ts`："reject missing token -> 401"、"reject wrong run token -> RUN_TOKEN_INVALID" |
| CP-LLM-002 | integration | terminal/waiting run rejects LLM calls | 409 | existing | `llm/routes.integration.test.ts`："reject terminal run -> RUN_TERMINAL" |
| CP-LLM-003 | integration | fake LLM records usage once | LLMUsageRecord row | existing | `llm/routes.integration.test.ts`："records usage as LLMUsageRecord without changing run status" |
| CP-LLM-004 | integration | OpenAI tool schema normalization | stable tool call object | existing | `llm/provider.test.ts`："normalizes tool calls as complete objects, not text chunks"、"normalizes Pi-style tools to OpenAI function tools before provider calls" |
| CP-LLM-005 | integration | true streaming provider path | chunk parser emits content/thinking incrementally | existing（2026-07-12 补齐） | `llm/provider.test.ts` 验证 provider terminal 前 delta、分片 tool arguments、截断流失败；`llm/routes.integration.test.ts` 的 "real provider streams chunks through Redis before done" 使用真实 provider + Redis 验证逐 chunk 输出 |
| CP-SEARCH-001 | integration | search proxy fake/http/exa shape | normalized results | existing | `search/routes.integration.test.ts`："fake provider returns normalized results and records usage/source records" |
| CP-SEARCH-002 | integration | search retry/non-retry policy | 5xx retry, 4xx no retry | existing | `search/routes.integration.test.ts`："retries on 5xx up to 2 times with backoff"、"does not retry on 4xx -> SEARCH_PROXY_FAILED" |

#### CP-SWEEP

| ID | 层级 | 用例 | Oracle | 状态 | 测试文件 |
| --- | --- | --- | --- | --- | --- |
| CP-SWEEP-001 | integration | stale created/provisioning/running interrupted/failed | terminal transition | existing | `sweep/run-sweep.integration.test.ts`："marks stale running run as interrupted and releases sandbox claim"、"marks stale provisioning_sandbox run as timeout"、"marks stale created run as failed" |
| CP-SWEEP-002 | integration | waiting_for_input only after threshold | no early cleanup | existing | `sweep/run-sweep.integration.test.ts`："does not sweep fresh running or waiting_for_input runs within threshold"、"marks waiting_for_input run past threshold as interrupted" |
| CP-SWEEP-003 | integration | orphan Redis stream cleanup | old stream deleted only | existing | `redis/stream-cleanup.integration.test.ts`："deletes stream key for terminal run older than grace and is idempotent"、"does not delete active or terminal streams still inside grace" |
| CP-SWEEP-004 | integration | orphan sandbox cleanup does not recreate sandbox | stop via get, not getOrCreate | existing | `sandbox/workspace-sandbox.integration.test.ts`："orphan WorkspaceSandboxInstance is swept and marked stopped"（属于 Part 2 Sandbox Substrate 文件，但用例本身验证的是 Control Plane sweep 调用 sandbox 层的收口方式，故在此保留映射） |

### 4.4a CP-TOOL-005 / CP-SSE-005 收敛记录

已完成（2026-07-10）：

- `POST /api/ingest/tool-calls` 在 `running` 创建/转移后写 `tool_call_started`，在 `completed` 后写 `tool_call_completed`，在 `failed`/`rejected`/`timeout` 后写 `tool_call_failed`。`rejected` 和 `timeout` 保留 `RunToolCall.status` 原值，同时在用户可见 timeline 上按失败类事件呈现。
- `RunToolCall.eventSeq` 与 `RunEvent.seq` 共用同一个 run 内递增命名空间；调用方必须为 tool start、工具副作用事件（如 `file_written`/`artifact_created`/`source_recorded`）、tool terminal 分配不同 seq。为此同步更新了 Pi runtime adapter、sandbox script、旧 deterministic agent-loop 和 scripted fixture，避免 tool lifecycle event 与副作用事件抢占同一 seq。
- `ingest/routes.integration.test.ts` 现在验证 `pending/running -> completed` 会产生 `tool_call_started`/`tool_call_completed`，验证 `failed`/`rejected` 会产生 `tool_call_failed`，并保留并发终态上报"只有一个赢家"的测试。
- `run/event-sse.integration.test.ts` 新增 tool lifecycle snapshot 覆盖，确认 `tool_call_started`/`tool_call_completed` 会进入 SSE snapshot。
- `sandbox/scripted-ingest-fixture.integration.test.ts` 更新 fixture 主路径断言，确认真实 ingest HTTP 路径下 run timeline 包含 tool lifecycle 事件。

### 4.4b CP-SSE-006 归属澄清

`CP-SSE-006`（"content chunk arrives before final agent_message"）的行为已经有自动化测试覆盖，不是代码缺口，是文档/归属缺口：

- 现有测试：`agent-loop/agent-loop.workflow.test.ts` 的 `"streams LLM chunks to Redis before semantic events are persisted"`（`it.skipIf(!HAS_REDIS)`）。LLM Proxy 收到 delta 后直接写 Redis，旧自写 loop 不再二次 POST；测试在写 `agent_thinking`/`agent_message` 前读取 Redis，断言两条 chunk 已存在，随后验证顺序为 `["thinking","content"]` 以及语义事件内容一致。
- 该用例在 `docs/testing-case-catalog.md` 里已经登记为 `AGENT-W-002`，归类在 "Agent Loop"，既不属于本文档的 Control Plane（Part 1），也不属于 Redis Streaming（Part 4）。

裁定：`CP-SSE-006` 验证的是"Redis stream chunk 先于语义 RunEvent 落库"这个协议机制本身，机制层面已经有测试覆盖（`AGENT-W-002`），职责上更贴近 Part 4 Redis Streaming（"content/thinking chunk 的瞬时流、cursor、重连、清理"，见 §1 模块表），因为它验证的是 chunk 相对语义事件的时序，而不是 Control Plane 内部状态机或鉴权。本文档不再把 `CP-SSE-006` 标记为 Control Plane 的独立缺口；进入 Part 4 时应把 `AGENT-W-002` 正式收编为该层的验收用例。

需要注意的边界：`AGENT-W-002` 仍是旧自写 agent-loop + fake LLM；2026-07-12 production Pi + real-provider gate 已补齐真实路径。content/thinking 均在最终语义事件前进入 Redis，长回复完整回放，最终 `agent_message`/`agent_thinking` 分别与对应 delta 拼接一致。`LLM-W-106`、`LLM-W-107`、`WF-012` 均已关闭。

### 4.4 Part 1 验收门槛

Control Plane 进入下一部分前，必须完成：

1. 把 `existing` case 映射到具体测试文件。—— 已完成，见 §4.3 各表「测试文件」列。
2. 将 `CP-TOOL-005` 和 `CP-SSE-005` 从 `gap` 做到 `done`。—— 已完成，见 §4.4a。
3. 将 `CP-SSE-006` 明确归属到 Redis Streaming 或 Control Plane，不允许两边都不负责。—— 已归属 Redis Streaming（Part 4），见 §4.4b；Control Plane 侧不再需要为它新增测试。
4. `pnpm test`、`pnpm test:integration`、相关 `pnpm test:workflow` 全绿。—— 待最终验证。
5. 文档更新 `testing-case-catalog.md`，不能只在本文件标 done。—— 已同步。

## 5. Part 2: Sandbox Substrate

目标：证明 sandbox 本身可靠，不带 Pi runtime。

测试方法：

- Unit：name/path/env policy。
- Integration：真实 Vercel Sandbox create/reuse/stop/read/write/list/exec。
- Failure：exec timeout、危险命令、路径越界、stdout/stderr 截断。
- Security：sandbox env 不含 DB/Auth/Redis/provider key。

完成后才能说 runtime 的执行环境可信。

## 6. Part 3: Runtime Tools

目标：证明 Pi runtime tool surface 正确。

测试方法：

- Unit：tool schema、args validation、tool result shape。
- Component：read/write/list/run_command/search/fetch/artifact 工具 side effect。
- Workflow：真实 sandbox 中 deterministic fake provider 触发每个工具。
- Failure：tool failed/rejected/timeout 如何映射 RunToolCall 和 RunEvent。

完成后才能接真实 provider。

## 7. Part 4: Redis Streaming

目标：证明 content/thinking 是真正流式，不丢不重。

测试方法：

- Integration：XADD/XREAD、TTL、cursor `0`、Last-Event-ID。
- Workflow：provider chunk -> LLM Proxy 同步 fan-out 到 Sandbox SSE + Redis -> browser SSE -> done；`/api/ingest/stream-chunk` 只保留给非 LLM Proxy 的瞬时输出和旧 fixture。
- Failure：断线重连、空洞、重复 chunk、terminal 后拒绝。

### 7.1 Provider 与延迟边界

- provider channel 由 Control Plane 按 `modelHint` 映射，Sandbox 不持有 provider channel 或密钥。普通 reasoning/content 回合发送 `modelHint=pi-runtime`（production 使用 `LLM_CHANNEL_PI_RUNTIME=2`）；仍有用户明确点名的必需工具时发送 `modelHint=pi-runtime-tools`，并由 Control Plane 选择 tool-capable channel。
- 2026-07-12 capability probe：channel 1 的配置模型只返回 content；channel 2 的配置模型同时返回 reasoning/content；channel 3 在探测时返回 429，因此不作为 Pi runtime 当前 release channel。
- LLM Proxy 从请求开始计时到首个 reasoning/content delta，终态 SSE metadata 和 `LLMUsageRecord.ttfbMs` 使用同一值。实测基线约 5.7-8.0 秒，release gate 暂定 `ttfbMs <= 15_000`。
- 不允许为了减少 Redis entry 数量而等待或批量攒 thinking/content；每个 provider delta 立即同步 fan-out 到 Sandbox SSE 和 Redis。

### 7.2 2026-07-12 验收结果

| 验收面 | 自动化证据 | 结果 |
| --- | --- | --- |
| Redis cursor/retention | `redis/streams.integration.test.ts`、`run/event-sse.integration.test.ts` | cursor `0`、Last-Event-ID、1500+ entries 回放、TTL/cleanup 均通过 |
| LLM Proxy fan-out/TTFB | `llm/routes.integration.test.ts` | reason/content 同步写 SSE + Redis；terminal metadata 与 usage record TTFB 一致 |
| Pi real content/reasoning | `pi-runtime/pi-runtime.workflow.test.ts` | 首批 chunk 到达时最终语义事件为 0；结束后两类流分别与 `agent_message`/`agent_thinking` 完全一致 |
| Authenticated browser SSE | `live/deployed-api.live.test.ts` + production deployment `dpl_3dN7msEEmRvq97i1cDQWjpBWqWPp` | cookie + CORS POST SSE、cursor `0`、断开后 Last-Event-ID 续传、无重复无丢失、thinking/content 均可见 |

验收中修复了两个只会在真实 reasoning-first 长流中稳定暴露的问题：Pi 后台 stream task 未被 finalize 显式等待，以及最终 `agent_message` 错把 thinking 与 content 拼在一起。现在 finalize 会等待全部 stream task，`agent_thinking` 与 `agent_message` 分开持久化。

Part 4 已关闭，可以进入 Part 5 Workspace Mapping。

## 8. Part 5: Workspace Mapping

目标：明确 DB facts 和 sandbox working copy 的同步边界。

测试方法：

- Unit：path/revision/diff policy。
- Integration：WorkspaceFile -> `/workspace` 水合。
- Workflow：run 前水合、run 中 write_file 回写、run_command 临时文件边界。
- Failure：删除、覆盖、冲突、超大文件、非 inline 内容。

### 8.1 同步协议

- `Workspace.fileRevision` 是 workspace 级单调水位；每次 WorkspaceFile 写入/删除在同一事务内取得新 revision。
- `syncedUpToRevision=NULL` 表示 cold/fresh sandbox；非空时只查询 `(synced, target]` 增量。
- Control Plane stage `pendingSyncRevision`，Pi boot 在任何 heartbeat/event 前应用 `filesToSync`，`run_completed` 在释放 sandbox 前推进 watermark。
- Vercel `onCreate` 或显式 404 fallback create 都视为 fresh，必须清空旧 watermark。
- Artifact 不自动水合；只有 WorkspaceFile 是文件 working copy 的下行事实。`run_command` 文件不自动 ingest。

### 8.2 2026-07-12 验收结果

| 验收面 | 自动化证据 | 结果 |
| --- | --- | --- |
| revision/diff | `workspace-mapping/sync.integration.test.ts` | cold 全量、warm 增量、并发 revision 唯一、overwrite/delete 均通过 |
| 文件 API | `files/routes.integration.test.ts` | ingest 原子分配 revision，soft-deleted 文件不出现在 list/content |
| Pi boot working copy | `pi-runtime/pi-runtime.workflow.test.ts` | 真实 Vercel Sandbox 中完成 hydrate、overwrite、delete；`run_command` 临时文件不进入 DB |
| 产品 auto-start | `agent-loop/agent-loop.workflow.test.ts` | 正常 POST run 前水合，Pi `read_file` 读到 DB 内容，watermark 推进到 workspace revision |
| fresh recovery live | `live/deployed-api.live.test.ts` + production deployment `dpl_JAYkqzC6jNEpbPfj6jVhTeRWMKgZ` | ephemeral session 不可用后 deployed API fresh create，重新从 Neon 物化 `/workspace` 并读回 marker |
| 非 inline failure | `workspace-mapping/sync.integration.test.ts` | storage-only/binary 在对象存储下载未实现时明确拒绝 provisioning，不静默漏文件 |

Part 5 已关闭，可以进入 Part 6 Full Product Path。

## 9. Part 6: Full Product Path

目标：只在模块都稳定后验证真实用户链路。

测试方法：

- Workflow：fake provider + real sandbox + hosted callback。
- Live：real provider + deployed API + real sandbox。
- Browser E2E：login -> workspace -> thread -> run -> tool timeline -> streaming -> artifact。

完整链路只用于 release gate，不用于代替模块测试。

### 9.1 2026-07-12 验收结果

| 验收面 | 自动化证据 | 结果 |
| --- | --- | --- |
| hosted success path | `apps/api/src/live/deployed-api.live.test.ts` | real provider + deployed API + Vercel Sandbox 完成 tool/file/artifact 回调；7 passed / 2 gated skipped |
| browser success/recovery | `apps/web/e2e/full-product-path.live.spec.ts` | signup -> workspace/thread/run -> Exa -> tool timeline -> artifact/source/usage -> refresh recovery 通过 |
| browser cancel | 同上 | provisioning/running 前取消写 `run_cancelled` 事实，刷新后恢复通过 |
| browser failure | 同上 | policy-rejected `run_command` 产生 failed tool event 和 `run_failed`，不再 false-complete |
| responsive shell | 同上 | desktop + Pixel 7 注册和空 composer gate 通过 |
| deploy | API `dpl_9EM1KpfV7aqVd5JpXGfwjCKmY87Z`；Web `dpl_EAxPqvVPQiVHTA6pmjvvpYdLepQB` | canonical hosts Ready |

本轮同时修复了三个只有 Full Product Path 才暴露的问题：tool-capable/reasoning channel 分工、早取消缺少终态事件、刷新后 active thread 丢失。Part 6 当前产品 release path 已关闭。`waiting_for_input -> Stage2` 的浏览器交互仍保留为 Group 20 独立扩展项；其后端 workflow 已有覆盖，但本轮没有伪装成 browser done。

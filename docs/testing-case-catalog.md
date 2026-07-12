# 测试用例目录 — 覆盖矩阵和落地状态

这份文档是测试用例管理入口。它不替代 [testing-strategy.md](./testing-strategy.md) 和 [testing-philosophy.md](./testing-philosophy.md)：

- `testing-philosophy.md`：为什么这么测。
- `testing-strategy.md`：测试层级、环境、命名、命令。
- `architecture-test-plan.md`：按 Control Plane、Sandbox、Runtime、Redis、Workspace Mapping、完整链路逐层收敛。
- `testing-case-catalog.md`：具体 case ID、覆盖点、运行层级、当前状态。

状态标记：

```text
done       已有自动化测试覆盖
partial    已有覆盖，但还缺关键分支或真实环境
planned    已列入，尚未实现
blocked    缺外部环境/产品能力，暂不能完整自动化
```

## 1. Suite Map

| Suite | Command | File Pattern | Purpose | Cost |
| --- | --- | --- | --- | --- |
| unit/route | `pnpm test` | `*.test.ts` | 纯逻辑、轻量 API contract | cheap |
| component integration | `pnpm test:integration` | `*.integration.test.ts` | 单模块真实边界，Neon/Redis/Vercel Sandbox | paid |
| workflow | `pnpm test:workflow` | `*.workflow.test.ts` | 无 UI 完整后端路径 | paid |
| live | `pnpm test:live` | `*.live.test.ts` | deployed API / real provider / expensive matrix | paid/expensive |
| browser E2E | `pnpm e2e` | `*.e2e.ts` | 真实浏览器用户路径 | paid |

## 2. Environment Matrix

| Env | Required Variables | Used By | Notes |
| --- | --- | --- | --- |
| Neon | `DATABASE_URL` | integration/workflow/live | 测试必须只清理自己创建的 prefix 数据 |
| Auth | `BETTER_AUTH_SECRET` | integration/workflow/live | live 写入使用预置测试账号 |
| Redis | `REDIS_URL` | stream/SSE/workflow | Redis Streams cursor 续读核心依赖 |
| Vercel Sandbox | `VERCEL_TOKEN` or `VERCEL_OIDC_TOKEN` | sandbox/workflow/live | 所有 sandbox coverage 必须真实 Vercel |
| Deployed API | `CAP_API_BASE_URL` or `API_BASE_URL` | live/deployed callback | sandbox 内回调公网 Control Plane 必须使用它 |
| Live Account | `CAP_LIVE_TEST_EMAIL`, `CAP_LIVE_TEST_PASSWORD` | live write workflow | 不自动注册，避免污染账号表 |
| Exa | `EXA_API_KEY` | search smoke/live | 真实搜索 provider |
| Real LLM | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `LLM_MODEL` | LLM smoke/live | OpenAI-compatible provider |
| LLM Fallback | `OPENAI_API_KEY2`, `OPENAI_BASE_URL2`, `LLM_MODEL2` or fallback model vars | LLM live fallback | 多 channel / fallback matrix |

## 3. Implemented Coverage

| ID | Level | Area | Coverage | Status |
| --- | --- | --- | --- | --- |
| AUTH-I-001 | integration | Auth | sign-up / sign-in / get-session / bad password / duplicate email | done |
| AUTH-I-002 | integration | Auth | `GET /api/me` authenticated / unauthenticated / invalid cookie | done |
| WS-I-001 | integration | Workspace | CRUD, ownership, archive | done |
| WS-I-002 | integration | Workspace | archived workspace atomic reject race | done |
| THREAD-I-001 | integration | Thread | CRUD, title derivation, ownership | done |
| RUN-U-001 | unit | Run | legal/illegal transitions and derived UI state | done |
| RUN-I-001 | integration | Run | create/read/cancel route behavior | done |
| RUN-I-002 | integration | Run | transition race and terminal overwrite prevention | done |
| RUN-I-003 | integration | Run sweep | stale running/provisioning/cancel convergence and race safety | done |
| RUN-I-004 | integration | Run sweep | waiting_for_input threshold interrupts only after 7 days | done |
| RUN-I-005 | integration | Run sweep | stale created run is failed by sweep | done |
| EVENT-U-001 | unit | Events | payload validation and ordering helpers | done |
| EVENT-I-001 | integration | Events | ingest events, seq idempotency/conflict | done |
| REDIS-I-001 | integration | Redis | stream-chunk writes Redis and does not create RunEvent | done |
| REDIS-I-002 | integration | Redis | stream cleanup deletes old streams only | done |
| REDIS-I-003 | integration | Redis | more than 1000 fine-grained deltas retain full cursor-0 replay | done（1500 entries，分页回放保留首尾） |
| SWEEP-I-001 | integration | Sweep | orphan resource cleanup paths: sandbox instance and Redis streams | done |
| SWEEP-U-001 | unit/route | Sweep | cron endpoint auth and sweep orchestration | done |
| SSE-I-001 | integration | SSE | snapshot, live events, done for terminal/waiting | done |
| SSE-I-002 | integration | SSE | cursor `0`, Last-Event-ID resume no duplicate/no lost chunk | done |
| SANDBOX-I-001 | integration | Sandbox | real Vercel create/reuse/resume/warm claim | done |
| SANDBOX-I-002 | integration | Sandbox | concurrent claim only one winner | done |
| SANDBOX-I-003 | integration | Sandbox | scripted runner in real Vercel with scoped token | partial |
| SANDBOX-I-004 | integration | Sandbox | agent-loop files injected and Node starts inside real Vercel | done |
| FILE-I-001 | integration | Files | ingest file, list, read content, ownership | done |
| WM-I-001 | integration | Workspace Mapping | cold full sync and warm revision diff | done |
| WM-I-002 | integration | Workspace Mapping | overwrite/delete tombstones and concurrent monotonic revisions | done |
| WM-I-003 | integration | Workspace Mapping | storage-only file rejects hydration explicitly | done |
| WM-W-001 | workflow | Workspace Mapping | Pi boot hydrates/overwrites/deletes files in real Vercel Sandbox | done |
| WM-W-002 | workflow | Workspace Mapping | `run_command` temporary file is not promoted to WorkspaceFile | done |
| WM-W-003 | workflow | Workspace Mapping | auto-start orchestrator hydrates before Pi and advances watermark on completion | done |
| WM-L-001 | live | Workspace Mapping | deleted persistent sandbox fresh-creates and rehydrates from Control Plane | done（2026-07-12 production deployment `dpl_JAYkqzC6jNEpbPfj6jVhTeRWMKgZ`） |
| ART-I-001 | integration | Artifacts | create/update/version/detail/download | done |
| SRC-I-001 | integration | Sources | URL/search_result source ingest and artifact references | done |
| SEARCH-I-001 | integration | Search | fake/http provider, retry, 4xx no retry, usage | done |
| SEARCH-S-001 | smoke | Search | real Exa provider returns normalized results | partial |
| USAGE-I-001 | integration | Usage | records listing, filters, pagination, no balance rejection | done |
| TOOL-I-001 | integration | fetch_url | SSRF guard, retry, failed/rejected status, source recording | done |
| TOOL-I-002 | integration | web_search | tool result -> Source records | done |
| RT-U-001 | unit/component | Pi runtime tools | `read_file` large output truncation matches sandbox script budget | done |
| RT-C-002 | component | Pi runtime tools | `fetch_url` SSRF rejection maps to `RunToolCall.status=rejected` | done |
| RT-C-003 | component | Pi runtime tools | successful `fetch_url` records `Source(kind=url)` before tool completion | done |
| RT-W-004 | workflow | Pi runtime tools | standalone sandbox `fetch_url` enforces network/SSRF policy and records URL source | done（2026-07-12 production API + Vercel Sandbox 实跑：`fetch_url:completed`，抓取结果与 `Source(kind=url)` 均已验证） |
| LLM-U-001 | unit | LLM | model config, finish_reason normalization | done |
| LLM-U-002 | unit | LLM | retry/fallback/timeout shell using fake transport | done |
| LLM-I-001 | integration | LLM Proxy | auth, terminal reject, fake output, usage, stream | done |
| AGENT-W-001 | workflow | Agent Loop | non-streaming fake LLM -> files/artifact/tool calls/completed | done |
| AGENT-W-002 | workflow | Agent Loop | reason/content chunks -> Redis before semantic events | done |
| AGENT-W-003 | workflow | Agent Loop | SSE replays stream chunks from cursor `0` | done |
| AGENT-W-004 | workflow | Agent Loop | SSE Last-Event-ID resumes without duplicate/lost chunks | done |
| AGENT-W-005 | workflow | Agent Loop | tool calls remain complete objects, not stream chunks | done |
| LIVE-L-001 | live | Deployed API | deployed `/health`, `/api/health`, CORS, unauthenticated browser endpoints | done |
| LIVE-L-002 | live | Deployed API | authenticated workspace/thread/run/resource API against hosted API | done |
| LIVE-L-003 | live | Pi AI Runtime | hosted API creates run, real Vercel Sandbox starts Pi runtime, file/artifact are readable through public API | done |
| DEPLOY-L-001 | live | Hosted API | `apps/api` Vercel production Ready and `/health` public 200 | done |
| DEPLOY-L-002 | live | Hosted Web | `apps/web` Vercel production Ready with `API_PROXY_TARGET` pointing at hosted API | done |
| DEPLOY-L-003 | live | Web/API rewrite | web `/api/health` reaches hosted API, not `localhost:8787` | done |
| RUNTIME-W-001 | workflow | Pi AI Runtime | sandbox starts Pi AI runtime and completes deterministic run through hosted API | done |

## 4. LLM Case Matrix

| ID | Level | Scenario | Required Env | Status |
| --- | --- | --- | --- | --- |
| LLM-U-101 | unit | provider response normalization: content only | none | done |
| LLM-U-102 | unit | provider response normalization: reasoning/thinking + content | none | done（非流式与 SSE parser 均覆盖） |
| LLM-U-103 | unit | provider response normalization: tool calls | none | done |
| LLM-U-104 | unit | finish reason normalization across providers | none | done |
| LLM-U-105 | unit | retry on 5xx/network error then success | none | done |
| LLM-U-106 | unit | no retry on non-retryable 4xx | none | planned |
| LLM-U-107 | unit | timeout attempt retries/fallbacks | none | done |
| LLM-U-108 | unit | first-token timeout policy switches provider | none | planned |
| LLM-U-109 | unit | max context policy: truncate/summarize/reject | none | planned |
| LLM-I-101 | integration | `/api/llm-proxy` stream emits reason/content chunks in order | DB/Auth | done |
| LLM-I-102 | integration | `/api/llm-proxy` records usage exactly once per call | DB/Auth | done |
| LLM-I-103 | integration | terminal/waiting run rejects LLM call | DB/Auth | done |
| LLM-I-104 | integration | streaming terminal metadata and LLMUsageRecord persist the same TTFB | DB/Auth/Redis | done |
| LLM-W-101 | workflow | agent loop streams reason/content to Redis and persists semantic events once | DB/Auth/Redis | done |
| LLM-W-102 | workflow | tool calls are complete objects over ingest/run detail | DB/Auth/Redis | done |
| LLM-W-103 | workflow | no-thinking model: content streams, no agent_thinking event | DB/Auth/Redis | partial（Pi adapter content-only component case 已覆盖；完整 workflow 待补） |
| LLM-W-104 | workflow | thinking-only or empty-content edge case | DB/Auth/Redis | planned |
| LLM-W-105 | workflow | malformed tool call -> tool failed and run failed/interrupted | DB/Auth/Redis | planned |
| LLM-W-106 | workflow | Pi runtime real streaming: content chunks reach Redis/SSE before final agent_message | DB/Auth/Redis/Vercel | done（2026-07-12 production API + real Vercel Sandbox + real provider：首批 content 到 Redis 时 `agent_message=0`，1500-entry retention integration 通过，长回复完整分页回放，最终 `agent_message.content` 与全部 content delta 拼接一致） |
| LLM-W-107 | workflow | Pi runtime thinking enabled: reasoning chunks reach Redis/SSE as `thinking` | DB/Auth/Redis/Vercel | done（2026-07-12 channel 2 real-provider gate：thinking 在最终语义事件前进入 Redis；结束后 delta 拼接与单条 `agent_thinking` 完全一致，且先于 `agent_message`） |
| LLM-L-101 | live | real provider returns basic answer | Real LLM | planned |
| LLM-L-102 | live | real provider streaming first token under SLA | Real LLM | done（LLM Proxy terminal metadata 与 usage record 均记录 TTFB；production-backed reasoning gate 通过 `<=15s` release SLA，探测基线约 5.7-8.0s） |
| LLM-L-103 | live | real provider first-token timeout triggers fallback | Real LLM + fallback | planned |
| LLM-L-104 | live | real provider 429/5xx retry/fallback behavior | Real LLM test gateway | planned |
| LLM-L-105 | live | long context budget and truncation/summarization | Real LLM | planned |
| LLM-L-106 | live | real tool-call response remains complete object | Real LLM | planned |

## 5. Sandbox Case Matrix

| ID | Level | Scenario | Required Env | Status |
| --- | --- | --- | --- | --- |
| SBX-I-101 | integration | deterministic workspace-scoped name | none | done |
| SBX-I-102 | integration | provider status conversion | none | done |
| SBX-I-103 | integration | create real Vercel sandbox | Vercel | done |
| SBX-I-104 | integration | resume stopped sandbox | Vercel/DB/Auth | done |
| SBX-I-105 | integration | reuse warm/ready sandbox | Vercel/DB/Auth | done |
| SBX-I-106 | integration | concurrent claim only one winner | Vercel/DB/Auth | done |
| SBX-I-107 | integration | no DB/Auth/LLM/Search secrets inside sandbox | Vercel | done |
| SBX-I-108 | integration | write agent loop script and manifest into sandbox | Vercel | done |
| SBX-I-109 | integration | exec timeout maps to sandbox timeout error | Vercel | done |
| SBX-I-110 | integration | stdout/stderr truncation works | Vercel | partial（本地已补 captured stdout/stderr 截断回归测试；真实 Vercel exec gate 待跑） |
| SBX-I-111 | integration | path traversal rejected by sandbox wrapper | none/Vercel | done（path-guard + VercelSandbox wrapper 单测覆盖，拒绝发生在 SDK 调用前） |
| SBX-W-101 | workflow | sandbox script calls deployed ingest and completes run | Deployed API/Vercel | done（2026-07-12 对 `https://api.sandbox.maidang.me` 实跑：Vercel Sandbox 创建、Pi packages 安装、runtime 启动、hosted ingest 回调、文件/artifact/tool/run completed 全部通过） |
| SBX-W-102 | workflow | sandbox consumes deployed LLM Proxy SSE while Control Plane fans out chunks to Redis | Deployed API/Vercel/Redis | done（2026-07-12 production fake/real provider gates 均通过；Sandbox 增量消费、Redis 低延迟 fan-out、最终语义一致性已验证） |
| SBX-W-103 | workflow | sandbox script calls deployed search proxy | Deployed API/Vercel/Exa or fake | done（2026-07-12 production API + Vercel Sandbox + fake search 实跑：`web_search:completed`，2 条 `Source(kind=search_result)` 已验证） |
| SBX-W-104 | workflow | cancel request stops sandbox runner | Deployed API/Vercel | done |
| SBX-W-105 | workflow | waiting_for_input releases sandbox warm and Stage2 reuses it | Deployed API/Vercel | done |
| SBX-W-106 | workflow | Pi runtime tool calls emit user-visible timeline/SSE start/completed/failed events | Deployed API/Vercel | partial（本地已补 sandbox runner 脚本 seq 回归测试；Deployed API + Vercel gate 仍需具备公网 base URL 后跑） |
| SBX-W-107 | workflow | Pi runtime `run_command` failure/timeout/rejection maps to visible tool events and terminal policy | Deployed API/Vercel | partial（component 已锁定 terminal policy：非零 exit/timeout 作为 completed terminal result，policy rejection 作为 failed tool call；Deployed API + Vercel gate 待跑） |
| SBX-L-101 | live | cold start duration and ready latency telemetry | Deployed API/Vercel | planned |
| SBX-L-102 | live | snapshot/write-file stability before future snapshot migration | Vercel | planned |
| SBX-L-103 | live | dangerous command/path/network attempts are contained | Vercel | planned |

## 6. Workflow Case Matrix

| ID | Level | Scenario | Status |
| --- | --- | --- | --- |
| WF-001 | workflow | create workspace/thread/run -> agent loop -> file/artifact -> completed | done |
| WF-002 | workflow | reason/content Redis stream -> SSE cursor `0` replay | done |
| WF-003 | workflow | SSE Last-Event-ID resume no duplicate/no lost chunks | done |
| WF-004 | workflow | tool calls complete-object path | done |
| WF-005 | workflow | Stage1 -> waiting_for_input -> Stage2 artifact update | done |
| WF-006 | workflow | cancel running run and release sandbox | done |
| WF-007 | workflow | tool failure marks run failed and persists error | planned |
| WF-008 | workflow | tool rejected by policy/SSRF creates rejected tool call | planned |
| WF-009 | workflow | stale heartbeat sweep interrupts run | done |
| WF-010 | workflow | deployed sandbox callback completes full run | planned |
| WF-011 | workflow | tool call lifecycle is visible in timeline/SSE, not only run detail `toolCalls` | done |
| WF-012 | workflow | Pi runtime content/reasoning stream before final semantic event | done（production API + Vercel Sandbox + real provider：两类 chunk 均先于最终语义事件，结束后分别与 `agent_message`/`agent_thinking` 一致） |

### 6.1 与 architecture-test-plan.md 的交叉引用

[architecture-test-plan.md §4.3](./architecture-test-plan.md#43-control-plane-用例清单) 的 Control Plane 用例清单里，以下 case 已复核，结论如下：

- `CP-TOOL-005`（tool lifecycle appears in SSE timeline）和 `CP-SSE-005`（tool call lifecycle merged into SSE timeline）已在同一批改动中收敛：`/api/ingest/tool-calls` 会生产 `tool_call_started`/`tool_call_completed`/`tool_call_failed` RunEvent，`run/event-sse.integration.test.ts` 验证 SSE snapshot 可见，`ingest/routes.integration.test.ts` 和 `sandbox/scripted-ingest-fixture.integration.test.ts` 验证真实 ingest HTTP 路径会产生这些事件。因此本表 `WF-011` 标记为 done。`SBX-W-106` 仍标 partial，是因为 Deployed API + Vercel Sandbox 维度的 release gate 仍属于 Sandbox/Full Product Path 后续验收。
- `CP-SSE-006`（content chunk arrives before final agent_message）验证的是"Redis stream chunk 先于语义 RunEvent 落库"这个协议机制。`AGENT-W-002` 由 LLM Proxy 直接写 Redis，旧自写 loop 只消费 SSE；2026-07-12 production Pi + channel 2 real-provider gate 进一步证明 content/thinking 均先于最终语义事件，完整回放后分别与 `agent_message`/`agent_thinking` 一致。因此 `CP-SSE-006`、`LLM-W-106`、`LLM-W-107`、`WF-012` 均已完成。

## 7. Live / Expensive Case Matrix

| ID | Level | Scenario | Required Env | Frequency | Status |
| --- | --- | --- | --- | --- | --- |
| LIVE-001 | live | deployed `/health` | API base URL | PR/nightly | planned |
| LIVE-002 | live | deployed unauthenticated `/api/me` | API base URL | PR/nightly | planned |
| LIVE-003 | live | deployed sign-in + workspace/thread/run write smoke | API base URL + live account | nightly/manual | planned |
| LIVE-004 | live | deployed SSE connection and snapshot | API base URL + live account | nightly | planned |
| LIVE-005 | live | deployed sandbox -> Control Plane ingest callback | API base URL + Vercel | nightly | planned |
| LIVE-006 | live | deployed sandbox -> LLM proxy -> Redis stream -> SSE | API base URL + Vercel + Redis | manual/release | done（2026-07-12 production：authenticated POST SSE 从 cursor `0` 收到 thinking/content；断开后 Last-Event-ID 续传无重复无丢失；最终语义与完整 delta 拼接一致） |
| LIVE-007 | live | real Exa query and Source normalization | API base URL + Exa | nightly | planned |
| LIVE-008 | live | real LLM basic completion and usage | API base URL + LLM | nightly | planned |
| LIVE-009 | live | real LLM fallback and retry | API base URL + multi LLM | manual/release | planned |
| LIVE-010 | live | long-context expensive run | API base URL + LLM | manual | planned |
| DEPLOY-001 | live | `apps/api` independent Vercel project Ready | Vercel CLI/API | manual/release | done（production deployment `dpl_JAYkqzC6jNEpbPfj6jVhTeRWMKgZ` Ready，并 alias 到 canonical API host） |
| DEPLOY-002 | live | `apps/web` independent Vercel project Ready and no root Next.js detection | Vercel CLI/API | manual/release | planned |
| DEPLOY-003 | live | sandbox callback uses hosted API base URL | API base URL + Vercel | manual/release | planned |
| RUNTIME-001 | workflow/live | Pi AI runtime replaces product self-written loop | API base URL + Vercel + Pi AI | manual/release | planned |

## 8. Acceptance Rules

Before a backend feature is considered done:

1. Unit/route tests cover its local logic and API contract.
2. Component integration covers each real external boundary it touches.
3. Workflow tests cover any product state-machine branch it affects.
4. Live tests cover deployed API behavior if the feature depends on Vercel runtime, public callback URLs, real providers, cookies, CORS, or SSE over the network.
5. Any skipped paid/live test must state the missing env in code or suite docs.

Before UI work starts for a workflow:

1. The workflow test must already prove the backend state can be recovered from API/SSE.
2. Browser E2E should only verify UI interaction/rendering, not discover backend behavior for the first time.

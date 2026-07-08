# Agent Runtime Protocol

这份文档定义 Control Plane 和 Sandbox Runtime 的通信协议。

这是 agent-in-sandbox 架构里最重要的后端契约。

## 1. 目标

把完整 Agent Runtime 移到 sandbox 内运行，同时让持久化状态、凭证、认证、用量遥测和 UI streaming 仍由 Control Plane 管理。产品主路径使用真实 Pi AI runtime（`@earendil-works/pi`）；项目内自写 agent loop 只能作为 deterministic fixture 或迁移垫片。

Control Plane 负责：

- auth
- run creation
- usage telemetry
- sandbox provisioning
- scoped run token issuing
- ingest verification
- LLM proxy
- persistence
- SSE
- timeout/cancel convergence

Sandbox Runtime 负责：

- load run config
- run Pi AI runtime
- execute tools
- read/write workspace filesystem
- create artifacts
- record sources
- heartbeat
- call ingest
- poll/receive cancel

## 2. 信任边界

可信区域：

```text
Browser auth -> Control Plane -> Postgres/Object Storage/LLM provider
```

不可信区域：

```text
Sandbox Runtime -> tools -> network/files/commands
```

Sandbox 不允许拿到：

- database URL
- Better Auth cookies
- long-lived user tokens
- long-lived LLM provider keys
- cross-workspace credentials

Sandbox 可以拿到：

- run id
- workspace id
- thread id
- ingest URL
- LLM proxy URL
- scoped run token
- workspace root
- max steps/duration
- tool policy config
- public Control Plane API base URL

## 3. 端到端顺序

```text
1. Browser POST /api/threads/:threadId/runs
2. Control Plane authenticates user
3. Control Plane checks workspace ownership（如果 thread 有 waiting_for_input 的旧 run，先原子转为 completed，见 ADR-0019）
4. Control Plane creates user Message
5. Control Plane creates Run status=created
6. Control Plane creates scoped run token
7. Control Plane 认领/创建 SandboxInstance（原子 UPDATE 设置 currentRunId，见 ADR-0018）
8. Control Plane starts Pi AI runtime inside sandbox（产品主路径必须自动调度，不需要人工或测试 helper 手动启动）
9. Control Plane sets Run status=provisioning_sandbox/running as appropriate
10. Sandbox Runtime posts heartbeat/events through ingest
11. Browser listens on POST /api/runs/:runId/events（GET 保留兼容；从 body.lastEventId、Last-Event-ID 或起始 cursor 读取，见 ADR-0021）
12. Sandbox Runtime calls LLM proxy and tools；token 逐字转发经 stream-chunk（不落库），语义完整时落库（ADR-0011/0016/0017/0021）
13. Sandbox Runtime ingests files/sources/artifacts
14. Sandbox Runtime reports terminal event 或 run_waiting_for_input（ADR-0019）
15. Control Plane finalizes run；记录 LLMUsageRecord 用量遥测（ADR-0015，不做 reserve/debit 强制执行）
16. SSE sends done
```

> Credit reservation 步骤（旧版第 4/7 步）已按 [ADR-0015](./decisions/0015-usage-telemetry-and-ops-priorities.md) 移除——不再是"额度不足拒绝启动"，改为纯用量记录，不阻塞 run 创建流程。

## 4. Runtime 启动契约

Control Plane 使用 JSON config 启动 sandbox 内 Pi AI runtime（`@earendil-works/pi`）。当前代码里的自写 loop 可以继续作为测试 fixture，但不能作为最终产品 runtime。

示例：

```json
{
  "runId": "run_123",
  "workspaceId": "ws_123",
  "threadId": "thr_123",
  "userId": "usr_123",
  "prompt": "Research OpenClaw and produce a report.",
  "workspaceRoot": "/workspace",
  "ingestUrl": "https://api.example.com/api/ingest",
  "llmProxyUrl": "https://api.example.com/api/llm-proxy",
  "searchProxyUrl": "https://api.example.com/api/search-proxy",
  "controlUrl": "https://api.example.com/api/runs/run_123/control",
  "runToken": "scoped-token",
  "maxSteps": 80,
  "maxDurationSec": 1800,
  "toolPolicy": {
    "allowNetwork": true,
    "allowRunCommand": true,
    "denyCommands": ["rm -rf", "sudo", "dd"]
  }
}
```

规则：

- Config 只作用于一个 run。
- Token 必须过期。
- Token 应该通过环境变量或权限受限的临时文件传入。
- Runtime 不能打印 token。
- Control Plane 创建 run 后必须自动执行启动流程：`created -> provisioning_sandbox`，签发 scoped run token，认领/创建 workspace sandbox，sandbox ready 后 `provisioning_sandbox -> running`，再执行 Pi AI runtime。
- 若缺少可从 Vercel Sandbox 访问的 Control Plane public API base URL，或 sandbox/runtime 启动失败，run 必须收敛到 `failed`/`timeout`，不得长期停留在 `created`。

## 5. Runtime 生命周期

Runtime 阶段：

```text
boot
load_context
pi_ai_loop
finalize
exit
```

### 5.1 Boot

Runtime 必须：

- parse config
- validate required fields
- initialize ingest client
- set workspace root
- send heartbeat
- send `agent_started` or `runner_started` event

### 5.2 Load Context

Runtime 需要上下文：

- 当前 prompt
- 最近 thread messages
- workspace file listing/summary
- existing artifacts
- existing sources

P0 选项：

1. Control Plane 在 start config 里带上 context。
2. Runtime 调用一个 scoped context endpoint。

建议：

- 先从 start config 提供最小 context。
- context 变大后再增加 scoped context API。

### 5.3 Pi AI Loop

Pi AI runtime loop：

```text
while not terminal:
  check cancel
  check max steps/time
  call LLM proxy (stream)
  for each token received:
    ①（转发路径，ADR-0016/0021）POST /api/ingest/stream-chunk（内部 XADD 到 Redis stream，不落库）
    ②（攒批，ADR-0017）accumulatedText += token（sandbox 进程内存变量，不落盘不进 DB）
  when provider signal 语义边界完整（finish_reason / thinking→content 切换 / TEXT_MESSAGE_END）：
    ③（落库路径，ADR-0011）POST /api/ingest/events，把 accumulatedText 整段作为 content 落库
       （agent_thinking 或 agent_message，见 §7），清空 accumulatedText
  parse tool call or final response
  execute tool locally（tool call 不走攒批，收到即完整，直接落库，见 §7/ADR-0020）
  ingest tool call/events
  ingest file/source/artifact if produced
  if agent 判定需要用户输入（如 ADR-0013 Stage1 概览完成）：
    ingest run_waiting_for_input 事件，正常 finalize 退出（不是 crash，见 §5.4）
```

规则：

- 每个 tool call 都要有持久化 start/end。
- 长时间工作必须发送 heartbeat。
- token 攒批发生在 sandbox 进程内存里的普通字符串变量（如 `accumulatedText`），触发落库的条件是 LLM 协议自带的语义边界，不是固定时间/token 数量切分（[ADR-0017](./decisions/0017-token-accumulation-and-persistence-timing.md)）。
- 最终 artifact 通过 `create_artifact` 创建。
- 最终 assistant message 是可选输出；artifact 是主要交付物。

### 5.4 Finalize

Runtime 必须：

- 在能判断时上报 completed/failed/cancelled/waiting_for_input。
- flush pending ingest。
- 使用有意义的 exit code 退出。

上报 `run_waiting_for_input`（[ADR-0019](./decisions/0019-waiting-for-input-state.md)）也是一种合法的 finalize 路径，不是异常退出——runner 进程在这之后正常退出，不需要保持存活等待恢复。用户的后续回答会通过一个全新的 run 处理，不会尝试恢复这个已退出的进程。

Control Plane 仍然负责最终 run state convergence。

## 6. Ingest Client 契约

Headers：

```text
Authorization: Bearer <runToken>
Content-Type: application/json
```

通用字段：

```json
{
  "idempotencyKey": "run_123:event:12",
  "seq": 12
}
```

重试规则：

- network failures 使用相同 idempotency key 重试。
- duplicate accepted response 视为成功。
- different payload conflict 是 fatal。
- 401 token invalid 是 fatal。
- 409 terminal run 应停止 runner。

### 6.1 Stream Chunk（[ADR-0016](./decisions/0016-token-stream-relay-redis-pubsub.md)/[ADR-0021](./decisions/0021-token-stream-relay-redis-streams.md)，转发专用，不落库）

```text
POST /api/ingest/stream-chunk
```

Request：

```json
{
  "chunk": "<token 文本>",
  "streamType": "thinking" | "content"
}
```

行为：Control Plane 内部执行 `XADD run:{runId}:stream * chunk "<chunk>" type "<streamType>"`，不写数据库，纯 Redis 内存操作，毫秒级返回。这是 sandbox 侧转发路径（①）调用的端点，和落库路径（`POST /api/ingest/events`，③）完全独立，见 §5.3。

规则：

- 不需要 seq/idempotencyKey（Redis Streams entry ID 本身单调递增，充当去重和排序依据）。
- 不产生持久化事件，SSE 消费方直接从 Redis stream 读取转发，不经过 `AgentEvent` 表。
- run 进入终态或 `waiting_for_input` 后，对应 stream key 由 sweep job 按 TTL 清理（[ADR-0021](./decisions/0021-token-stream-relay-redis-streams.md)）。

## 7. Event Types

推荐 run event types：

```text
run_created
sandbox_provisioning
sandbox_ready
runner_started
agent_started
agent_thinking
agent_message
tool_call_started
tool_call_completed
tool_call_failed
file_written
source_recorded
artifact_started
artifact_delta
artifact_created
artifact_updated
artifact_failed
run_completed
run_failed
run_timeout
run_cancelled
run_waiting_for_input
```

`agent_thinking`/`agent_message` 取代了旧文档里含糊的 `model_step`（[ADR-0020](./decisions/0020-agent-event-payload-schema-and-tool-retry.md)）——不删除旧记录，标注为已被取代。`artifact_updated`（对应已存在 artifact 的新版本，见 §8.2）此前只在前端文档出现，本节补齐与后端对齐。`run_waiting_for_input`（[ADR-0019](./decisions/0019-waiting-for-input-state.md)）对应 Stage1→Stage2 交接点。

每种事件类型的 payload 具体 schema 见 [api-contract.md](./api-contract.md) `AgentEventPayloadMap`（[ADR-0020](./decisions/0020-agent-event-payload-schema-and-tool-retry.md)）。

P0 可以省略：

- `artifact_delta`

## 8. Tool Protocol

Tool definitions 存在 sandbox runner 内。

P0 最小工具：

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

每个 tool 必须定义：

- name
- description
- JSON schema
- policy rules
- timeout
- result shape
- ingest side effects

### 8.1 write_file

行为：

```text
write file under workspace root
compute size/hash
POST /api/ingest/files
POST /api/ingest/events file_written
```

规则：

- 必须 path guard。
- 自动创建父目录。
- 大文件走 object storage path。

### 8.2 create_artifact

行为：

```text
validate title/kind/content/path
ensure content snapshot exists
POST /api/ingest/artifacts
POST /api/ingest/events artifact_created 或 artifact_updated
```

规则：

- artifact 必须显式创建。
- workspace file 不会自动变成 artifact。
- artifact 在文件变化后仍必须可恢复。
- 请求带的 `artifactId` 留空或指向不存在的 id → 首次创建，`version = 1`，产生 `artifact_created`；指向已存在 artifact → 新版本（`version + 1`），产生 `artifact_updated`（[ADR-0020](./decisions/0020-agent-event-payload-schema-and-tool-retry.md)）。

### 8.3 run_command

行为：

```text
evaluate policy
execute command in workspace root
truncate output
record tool call
```

规则：

- 拒绝危险命令。
- 必须 timeout。
- 必须 output truncation。

### 8.4 web_search（[ADR-0020](./decisions/0020-agent-event-payload-schema-and-tool-retry.md)，解决 DQ-3）

必须经 Control Plane 代理，provider key（如 Exa）不进沙箱。

行为：

```text
build query params
POST /api/search-proxy （scoped run token）
Control Plane 持有 provider key，调用真实 search API
Control Plane 记录调用量（同 ADR-0015 usage telemetry 思路）
Control Plane 返回归一化结果列表
record_source（kind = search_result）对每条返回结果
```

规则：

- 超时 10s。
- 网络失败/5xx 最多重试 2 次，指数退避（500ms / 1500ms）——search 本身幂等，可以重试。
- provider 返回 4xx（查询被拒/quota 用尽）不重试，直接 `tool_call_failed`。
- 结果里每条 url 如果之后被 `fetch_url` 抓取，应记为 `source`（kind=`search_result`）。
- HTML/结果清洗放在 sandbox runner 侧，不是 Control Plane 服务。

### 8.5 fetch_url（[ADR-0020](./decisions/0020-agent-event-payload-schema-and-tool-retry.md)）

Sandbox 直接发起，不经代理——不需要密钥，`toolPolicy.allowNetwork` 已经覆盖了这个信任边界。

行为：

```text
validate url scheme（仅 http/https）
SSRF guard：拒绝 localhost/127.0.0.1/内网 CIDR（10.x/172.16.x/192.168.x/169.254.x）/云 metadata 地址
fetch content
truncate to size limit（如 5MB），超限标记 truncated: true
非文本 content-type 只记录 metadata，不解析全文
record_source（kind=url），不管是否被最终引用——ADR-0013 措辞纪律要求的证据链
```

规则：

- 超时 15s（网页比 API 慢）。
- 网络级失败（connect timeout/DNS 失败/5xx）最多重试 1 次（抓取成本比 search 高，1 次够处理瞬时抖动）。
- 4xx / SSRF guard 触发不重试，直接判 `tool_call_status = rejected`（policy 拦截）而不是 `failed`（执行报错）。

## 9. LLM Proxy 契约

Sandbox 调用：

```text
POST /api/llm-proxy
Authorization: Bearer <runToken>
```

Request：

```json
{
  "messages": [],
  "tools": [],
  "modelHint": "research-default",
  "stream": true
}
```

规则：

- Control Plane 校验 token。
- Control Plane 检查 run 是否 active。
- Control Plane 持有 provider credentials。
- Control Plane 记录 usage（落一条 `LLMUsageRecord`，纯遥测，不做 reserve/debit 强制执行，见 [ADR-0015](./decisions/0015-usage-telemetry-and-ops-priorities.md)）。
- Sandbox 接收模型输出。
- Runtime 判断"这段完整了"依赖 provider 的 `finish_reason` 字段（或等价信号），[ADR-0009](./decisions/0009-provider-anti-corruption-layer.md) 的防腐层必须保证这个信号在不同 provider 间被归一化，不能让 Pi AI adapter 直接处理 provider 差异（[ADR-0017](./decisions/0017-token-accumulation-and-persistence-timing.md)）。

P0：

- deterministic tests 使用 fake LLM proxy。
- integration smoke tests 使用 real provider。

## 10. Cancel Protocol

Control Plane：

- `POST /api/runs/:runId/cancel`
- 设置 run `cancel_requested`

Runtime cancellation 选项：

1. polling：runtime 每 N 秒调用 control endpoint
2. signal：Control Plane 调用 sandbox runtime endpoint
3. abort file：如果 sandbox API 支持，Control Plane 写 cancellation marker

P0 建议：

- 每 500-1000ms polling

Runtime 行为：

- 尽量在下一次 LLM/tool call 前停止。
- 尽量 abort active LLM proxy。
- 尽量 kill active command。
- ingest `run_cancelled`。
- exit。

Control Plane 行为：

- 如果 runtime 没有及时上报，sweep 根据策略最终标记 cancelled/timeout/interrupted。

## 11. Timeout And Sweep

Control Plane 负责 timeout。

Timeout 来源：

- maxDurationSec exceeded
- heartbeat stale beyond threshold
- provisioning took too long
- runtime process lost

Sweep 行为：

```text
running + stale heartbeat -> interrupted or timeout
provisioning_sandbox + stale -> timeout
cancel_requested + stale -> cancelled or timeout by policy
waiting_for_input + 超过阈值（默认 7 天）无人回应 -> interrupted（ADR-0019）
```

Sweep 同时负责清理孤儿资源（[ADR-0015](./decisions/0015-usage-telemetry-and-ops-priorities.md)）：

```text
孤儿 SandboxInstance（warm/ready 但无对应活跃 run）-> 停止/回收
过期 Redis stream key（run 已终态一段时间后）-> 删除（ADR-0021）
```

要求：

- 不允许任何 run 永久停留在 running。
- `waiting_for_input` 不计入"卡死"判定——它是合理挂起，不是异常状态，但同样不允许无限期停留（7 天阈值兜底）。
- 所有 sweep 转移必须走 [ADR-0018](./decisions/0018-atomic-state-transitions.md) 的条件原子 UPDATE。

## 12. 测试协议

必须完成的集成里程碑：

1. deterministic runtime fixture starts inside sandbox
2. deterministic runtime fixture heartbeats
3. deterministic runtime fixture ingests events
4. deterministic runtime fixture writes file and ingests metadata
5. deterministic runtime fixture creates artifact
6. deterministic runtime fixture creates a second version of same artifact（artifact_updated）
7. deterministic runtime fixture completes run
8. cancel request stops deterministic runtime fixture
9. stale runtime is swept
10. deterministic runtime fixture reports run_waiting_for_input，run 正常收尾，后续新 run 可创建
11. waiting_for_input run 超过阈值被 sweep 转 interrupted
12. deterministic runtime fixture streams chunks through stream-chunk（Redis Streams），SSE 从 cursor 续读
13. Pi AI runtime calls fake LLM proxy
14. Pi AI runtime calls real LLM in optional smoke test

测试必须证明：

- sandbox runtime 没有 DB credentials
- ingest 需要 run token
- token 不能跨 run/workspace 使用
- event snapshot 可以从 DB 恢复
- 并发状态转移只有一次生效（ADR-0018）
- token stream 转发不落库、SSE 重连从 Last-Event-ID 续读不丢失（ADR-0021）

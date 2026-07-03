# 状态机

这份文档定义合法状态转移和终态规则。

实现前必须先写纯函数 transition helpers，并为每个状态机补单元测试。

## 1. RunStatus

状态：

```text
created
provisioning_sandbox
running
waiting_for_input
cancel_requested
completed
failed
timeout
cancelled
interrupted
```

> `waiting_for_input`（[ADR-0019](./decisions/0019-waiting-for-input-state.md)）：agent 主动停下等用户选择（如 [ADR-0013](./decisions/0013-mechanism-deep-dive-refinement.md) 的 Stage1→Stage2 交接点）。非终态，但也不是"活跃执行中"——sandbox 进程已正常退出，run 携带一个待选问题挂起。

终态：

```text
completed
failed
timeout
cancelled
interrupted
```

状态转移：

```text
created -> provisioning_sandbox
created -> cancel_requested
created -> failed

provisioning_sandbox -> running
provisioning_sandbox -> cancel_requested
provisioning_sandbox -> failed
provisioning_sandbox -> timeout

running -> cancel_requested
running -> completed
running -> failed
running -> timeout
running -> interrupted
running -> waiting_for_input

waiting_for_input -> cancel_requested
waiting_for_input -> completed
waiting_for_input -> interrupted

cancel_requested -> cancelled
cancel_requested -> failed
cancel_requested -> timeout

completed -> none
failed -> none
timeout -> none
cancelled -> none
interrupted -> none
```

触发者：

```text
Control Plane:
- created -> provisioning_sandbox
- any non-terminal -> cancel_requested
- non-terminal -> timeout
- stale running -> interrupted
- waiting_for_input -> completed（创建新 run 前的原子收尾，见 ADR-0019）

Sandbox Runner through Ingest:
- provisioning_sandbox -> running
- running -> completed
- running -> failed
- running -> waiting_for_input

Sweep job:
- running -> interrupted
- provisioning_sandbox -> timeout
- waiting_for_input -> interrupted（超过阈值，默认 7 天，见 ADR-0019）
```

规则：

- 终态不可覆盖。
- `cancel_requested` 不是终态。
- `waiting_for_input` 不是终态，但也不是"活跃执行中"——sandbox 进程已退出，不发送 heartbeat。
- `completed` 需要 run completion event。
- `failed` 需要 error message。
- `timeout` 由 Control Plane 控制。
- `interrupted` 表示 Control Plane 已无法确认 run 仍然存活。
- 所有转移必须通过 [ADR-0018](./decisions/0018-atomic-state-transitions.md) 定义的条件原子 UPDATE（`transitionRun(runId, toStatus, fromStatuses[])`），不允许 check-then-act。

必测单元用例：

- 所有合法转移通过。
- 所有非法转移被拒绝。
- 终态拒绝所有转移。
- created/provisioning/running 都可以请求 cancel。
- timeout 可以收敛 provisioning/running/cancel_requested。
- running 可以转 waiting_for_input。
- waiting_for_input 不会在阈值（7 天）内被 sweep 误判为 interrupted。
- waiting_for_input 超过阈值会被 sweep 转 interrupted。
- 并发调用 `transitionRun` 时只有一次生效，另一次影响 0 行且不报错（route/integration 层验证，见 ADR-0018）。

## 2. DerivedUiState

从 `RunStatus` 和 `lastHeartbeatAt` 推导。

状态：

```text
idle
running
possibly_running
cancelling
waiting_for_input
completed
failed
timeout
cancelled
interrupted
```

规则：

- `created` -> `idle`
- `provisioning_sandbox` 且 heartbeat 新鲜或 createdAt 很近 -> `running`
- `running` 且 heartbeat 新鲜 -> `running`
- `running` 且 heartbeat 过期 -> `possibly_running`
- `cancel_requested` -> `cancelling`
- `waiting_for_input` -> `waiting_for_input`（直接映射，不需要 heartbeat 推导——sandbox 已退出，没有 heartbeat 可看）
- 终态直接映射自身
- `interrupted` -> `interrupted`

新鲜度阈值：

```text
fresh: heartbeat age <= 30s
possibly running: heartbeat age > 30s and <= maxDurationSec
interrupted candidate: heartbeat age > maxDurationSec or sweep threshold
```

必测用例：

- 每个 RunStatus 都有正确映射。
- stale heartbeat 映射到 possibly_running。
- 终态忽略 heartbeat。

## 3. WorkspaceStatus

状态：

```text
active
archived
```

转移：

```text
active -> archived
archived -> active
```

P0：

- archive 优先于 hard delete。
- archived workspace 不能创建新 thread 或 run。
- archived workspace 仍可读。

必测用例：

- archived workspace 创建 run 被拒绝。
- list 根据 query flag 包含/排除 archived。

## 4. ThreadStatus

状态：

```text
active
archived
```

转移：

```text
active -> archived
archived -> active
```

规则：

- archived thread 不能启动新 run。
- archived thread 仍可读。

必测用例：

- archived thread 创建 run 被拒绝。
- archived thread detail 可读。

## 5. SandboxStatus

状态：

```text
pending
provisioning
ready
warm
stopped
failed
```

转移：

```text
pending -> provisioning
provisioning -> ready
provisioning -> failed
ready -> warm
ready -> stopped
ready -> failed
warm -> ready
warm -> stopped
warm -> failed
stopped -> provisioning
failed -> provisioning
```

规则：

- `ready` 表示 sandbox 可以启动 runner。
- `warm` 表示 workspace 有可复用 sandbox。
- `stopped` 可以 resume 或 recreate。
- `failed` 必须记录 error detail。

必测用例：

- getOrCreate 可以复用 warm/ready sandbox。
- failed sandbox 可以重新 provision。
- stopped sandbox 优先使用 snapshot 恢复。

## 6. ToolCallStatus

状态：

```text
pending
running
completed
failed
timeout
rejected
```

终态：

```text
completed
failed
timeout
rejected
```

转移：

```text
pending -> running
pending -> rejected
running -> completed
running -> failed
running -> timeout
running -> rejected
```

规则：

- rejected 表示 policy 阻止执行（如 `run_command` 危险命令拦截、`fetch_url` SSRF guard 触发、`fetch_url`/`web_search` 收到 4xx 不重试直接判 rejected，见 [ADR-0020](./decisions/0020-agent-event-payload-schema-and-tool-retry.md)）。
- failed 表示工具尝试执行但报错（如网络级失败重试耗尽仍失败）。
- timeout 表示工具超过允许时长。
- completed 必须包含 result。

必测用例：

- rejected 不需要 sandbox command result。
- timeout 记录 error。
- terminal tool call 不能之后再 completed。
- fetch_url 触发 SSRF guard 产生 rejected，不是 failed。
- fetch_url/web_search 网络级失败在重试次数内最终成功 -> completed。
- fetch_url/web_search 重试耗尽后失败 -> failed，不是 rejected。

## 7. ArtifactStatus

P0 可以不落库 artifact status，先从事件推导。

如果落库：

```text
creating
ready
failed
archived
```

转移：

```text
creating -> ready
creating -> failed
ready -> archived
failed -> archived
```

规则：

- `ready` 必须有可恢复内容。
- artifact 在 run 终态后仍可读。
- artifact version 创建必须和内容持久化保持原子性。

必测用例：

- artifact 没有 content snapshot/storage 时被拒绝。
- ready artifact 可读。
- archived artifact 默认列表隐藏。

## 8. Credit Reservation

Ledger 类型：

```text
grant
reserve
debit
refund
adjustment
```

Run billing lifecycle：

```text
pre-run: reserve
success: debit actual + refund unused
cancelled: debit policy amount + refund unused
failed: debit policy amount + refund unused
timeout: debit policy amount + refund unused
```

规则：

- ledger append-only。
- 必须有 idempotency key。
- sandbox runner 启动前必须 reserve。
- available credits 不足时拒绝创建 run。
- 失败重试不能重复 reserve 或 debit。

必测用例：

- 点数不足拒绝 run。
- reserve 创建 ledger entry。
- completed run debit 并 refund。
- cancelled run 遵循退款策略。
- 幂等重试不重复写账。

## 9. Ingest Event Ordering

要求的偏序：

```text
run_created < sandbox_provisioning < sandbox_ready < agent_started
tool_call_started < tool_call_completed|tool_call_failed
artifact_started < artifact_created|artifact_failed
run_completed|run_failed|run_timeout|run_cancelled is last visible terminal event
```

规则：

- `seq` 在同一个 run 内严格递增。
- 相同 body 的重复 `seq` 可以幂等成功。
- 不同 body 的重复 `seq` 是 conflict。
- 终态 run 拒绝新 ingest，除非是已接受记录的精确重复。

必测用例：

- seq monotonicity
- duplicate same payload idempotency
- duplicate different payload conflict
- terminal run rejects new event
- terminal duplicate accepted idempotently


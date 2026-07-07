## ADDED Requirements

### Requirement: Run 状态机
Run 状态 SHALL 遵循合法转移表：`created → provisioning_sandbox → running → {completed|failed|timeout|cancel_requested|waiting_for_input}`，`waiting_for_input → {completed|cancel_requested|interrupted}`，`cancel_requested → {cancelled|failed|timeout}`。终态（`completed`/`failed`/`timeout`/`cancelled`/`interrupted`）MUST NOT 被覆盖。非法转移 MUST 被拒绝。

#### Scenario: 初始状态是瞬时持久化状态
- **WHEN** 创建一个新 run
- **THEN** 其初始持久化状态为 `created`，随后产品主路径 MUST 自动调度 runner 并推进到 `provisioning_sandbox`，不得长期停留在 `created`

#### Scenario: 正常主路径流转
- **WHEN** run 依次经过 sandbox 供给、agent 执行、完成
- **THEN** 状态依次为 `provisioning_sandbox → running → completed`

#### Scenario: Run 创建后自动调度真实 runner
- **WHEN** 用户通过 `POST /api/threads/:threadId/runs` 创建 run
- **THEN** Control Plane 自动签发 scoped run token、认领或创建真实 Vercel Sandbox、启动 sandbox 内 agent loop，runner 通过 ingest 回写 heartbeat/events/files/artifacts/sources

#### Scenario: 非法转移被拒绝
- **WHEN** 尝试将 `created` 状态的 run 直接转为 `completed`
- **THEN** 转移被拒绝，状态保持 `created`

#### Scenario: 终态不可覆盖
- **WHEN** 对已处于 `completed` 状态的 run 请求 cancel
- **THEN** 状态保持 `completed` 不变，请求返回 RUN_NOT_CANCELABLE

#### Scenario: running 可转 waiting_for_input
- **WHEN** sandbox 上报需要用户输入
- **THEN** run 状态从 `running` 转为 `waiting_for_input`

### Requirement: 状态转移原子性
所有 RunStatus 转移 MUST 通过唯一入口 `transitionRun(runId, toStatus, fromStatuses[])` 执行，内部实现为条件原子 UPDATE（`WHERE status = ANY(fromStatuses)`），不允许应用层"先查询再更新"的两步式逻辑。

#### Scenario: 并发转移只有一次生效
- **WHEN** 两个并发请求同时尝试将同一个 run 从 `running` 转为不同的终态
- **THEN** 只有一次转移成功生效，另一次因条件不满足返回 0 行影响且不抛出错误

#### Scenario: Sweep 与正常上报的竞态不会互相覆盖
- **WHEN** sweep 判定某 run 心跳过期准备标记为 `interrupted`，同一时刻 sandbox 上报该 run 已 `completed`
- **THEN** 无论哪次操作先落地，最终状态是先到达数据库的那次结果，另一次是无副作用的 no-op

### Requirement: waiting_for_input 不做进程恢复
Run 进入 `waiting_for_input` 时，sandbox runner MUST 正常退出（finalize 路径，非异常崩溃）。用户回答 MUST 通过创建新 run 处理，不恢复原 sandbox 进程。创建新 run 时，若该 thread 存在处于 `waiting_for_input` 的 run，SHALL 先将其原子转为 `completed`。

#### Scenario: 新 run 创建前收尾旧的 waiting_for_input run
- **WHEN** 某 thread 存在一个 `waiting_for_input` 状态的 run，此时用户在该 thread 发起新的 run 创建请求
- **THEN** 系统先将旧 run 原子转为 `completed`，再创建新 run

#### Scenario: waiting_for_input 释放 sandbox 供后续复用
- **WHEN** run 进入 `waiting_for_input`
- **THEN** 对应 SandboxInstance 的 `currentRunId` 被原子清空，状态转为 `warm`，可被后续 run 复用

### Requirement: Sweep 兜底收敛
系统级不变量：没有任何 run 允许永久停留在非终态。Sweep SHALL 定时扫描心跳过期的 `running`/`provisioning_sandbox`/`cancel_requested` run，以及超过阈值（默认 7 天）无响应的 `waiting_for_input` run，将其收敛到对应终态。

#### Scenario: 心跳过期的 running run 被收敛
- **WHEN** run 处于 `running` 且 `lastHeartbeatAt` 超过阈值
- **THEN** sweep 将其标记为 `interrupted`

#### Scenario: waiting_for_input 在阈值内不被误杀
- **WHEN** run 处于 `waiting_for_input` 且等待时长未超过 7 天阈值
- **THEN** sweep 不对其做任何转移

#### Scenario: waiting_for_input 超过阈值被收敛
- **WHEN** run 处于 `waiting_for_input` 且等待时长超过 7 天阈值
- **THEN** sweep 将其标记为 `interrupted`

### Requirement: Derived UI State 推导
系统 SHALL 从 `RunStatus` 和 `lastHeartbeatAt` 推导 `derivedUiState`；`waiting_for_input` 直接映射自身，不依赖心跳新鲜度。

#### Scenario: 心跳新鲜映射为 running
- **WHEN** run 处于 `running` 且心跳在阈值内
- **THEN** derivedUiState 为 `running`

#### Scenario: 心跳过期映射为 possibly_running
- **WHEN** run 处于 `running` 且心跳超过阈值但未达到 sweep 判定线
- **THEN** derivedUiState 为 `possibly_running`

#### Scenario: waiting_for_input 直接映射
- **WHEN** run 处于 `waiting_for_input`
- **THEN** derivedUiState 为 `waiting_for_input`，不受心跳状态影响

### Requirement: 取消协议
非终态 run（含 `created`/`provisioning_sandbox`/`running`/`cancel_requested`/`waiting_for_input`）SHALL 可以被请求取消；终态 run 的取消请求 MUST 被拒绝。

#### Scenario: 取消运行中的 run
- **WHEN** 对状态为 `running` 的 run 调用取消
- **THEN** run 状态转为 `cancel_requested`

#### Scenario: 取消终态 run 被拒绝
- **WHEN** 对状态为 `completed` 的 run 调用取消
- **THEN** 请求返回 RUN_NOT_CANCELABLE，状态不变

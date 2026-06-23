## ADDED Requirements

### Requirement: Run 状态机
Run 状态流转 SHALL 遵循合法转移：`created → provisioning_workspace → running → completed`，并可在任意运行态转入 `failed / timeout / cancelled / interrupted`。非法转移 MUST 被拒绝。

#### Scenario: 初始状态
- **WHEN** 新建一个 run
- **THEN** 其状态为 `created`

#### Scenario: 正常流转
- **WHEN** run 依次进入 workspace 初始化、agent 运行、最终完成
- **THEN** 状态依次为 `provisioning_workspace → running → completed`

#### Scenario: 非法转移被拒绝
- **WHEN** 尝试从 `created` 直接转移到 `completed`
- **THEN** 状态机拒绝该转移

#### Scenario: 终态不可破坏
- **WHEN** 对已 `completed` / `failed` / `cancelled` 的 run 再次请求取消
- **THEN** 最终状态保持不变

### Requirement: 心跳与中断判定
Agent loop SHALL 在关键时机更新 `lastHeartbeatAt`；当 run 处于 `running` 但心跳超过阈值时，系统 SHALL 将其判定为 `interrupted`。

#### Scenario: 心跳新鲜
- **WHEN** run 处于 running 且 `lastHeartbeatAt` 在阈值内
- **THEN** 派生 UI 状态为 `possibly_running`

#### Scenario: 心跳过期
- **WHEN** run 处于 running 且 `lastHeartbeatAt` 超过阈值
- **THEN** 系统标记 run 为 `interrupted`

### Requirement: 取消
平台 SHALL 支持取消运行中的 run：标记 `cancel_requested` 后 agent loop 不再进入下一轮模型调用，确认停止后置为 `cancelled`，且已落事件 MUST 保留。

#### Scenario: 请求取消
- **WHEN** 对运行中的 run 调用取消
- **THEN** run 状态变为 `cancel_requested` 并追加取消事件

#### Scenario: agent 读到取消
- **WHEN** agent loop 在下一轮开始前读到 `cancel_requested`
- **THEN** 停止继续调用 LLM，最终状态变为 `cancelled`，已完成事件保留

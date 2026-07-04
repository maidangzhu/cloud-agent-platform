## ADDED Requirements

### Requirement: 事件顺序与落库
每个 run 的 `AgentEvent` SHALL 拥有单调递增的 `seq`，同一 run 内 `seq` MUST 唯一；关键事件顺序 MUST 满足偏序约束。

#### Scenario: seq 单调递增
- **WHEN** 一个 run 依次追加多个事件
- **THEN** 事件 `seq` 严格单调递增

#### Scenario: seq 唯一
- **WHEN** 尝试为同一 run 写入重复 `seq`
- **THEN** 写入被拒绝

#### Scenario: 关键事件偏序
- **WHEN** 检查一个 run 的事件序列
- **THEN** `run_created` 早于 `agent_started`，且每个工具的 `tool_call_started` 早于其 `tool_call_completed`

#### Scenario: 终态后不追加运行事件
- **WHEN** run 已进入 `completed` 后尝试追加普通运行事件
- **THEN** 该追加被拒绝

### Requirement: Artifact 表兼容保留
Artifact 表 SHALL 保留用于兼容历史数据与未来文件产物，但主流程最终回答 SHALL 以 assistant Message 作为唯一展示来源。

#### Scenario: 最终回答不写 Artifact
- **WHEN** agent 生成最终报告
- **THEN** 平台 SHALL 写入 assistant Message
- **AND** 平台 SHALL NOT 写入 Artifact

### Requirement: 刷新与恢复
平台 SHALL 以数据库为唯一事实源；SSE 连接断开后，重新进入 MUST 能从已落事件与 Message 恢复展示。

#### Scenario: 完成后刷新
- **WHEN** run 完成后刷新页面
- **THEN** 能从数据库恢复完整事件流与 assistant 最终回答

#### Scenario: 失败后刷新
- **WHEN** run 失败后刷新页面
- **THEN** 能看到失败原因与已保存的部分事件

## ADDED Requirements

### Requirement: 多轮会话
平台 SHALL 以 `Session` 为长期会话容器：用户在一个 Session 内可多次发送消息，每条消息触发一次 `Run`，且同一 Session 内的多次 Run MUST 复用同一个 workspace。

#### Scenario: 创建会话
- **WHEN** 用户通过有效邀请码创建会话
- **THEN** 系统建立一个 `Session`（状态 `active`）并准备其 workspace

#### Scenario: 会话内追问
- **WHEN** 用户在已有会话内发送第二条消息
- **THEN** 系统在该会话下新建一个 Run，复用同一 workspace，且把历史对话作为上下文提供给模型

#### Scenario: 对话历史作为上下文
- **WHEN** agent 在第二轮 Run 中推理
- **THEN** 模型能看到第一轮的用户消息与助手回复（多轮记忆连续）

### Requirement: 对话消息持久化
用户与 agent 的对话 SHALL 以 `Message`（role=user/assistant）按行持久化到 Session；`Message` 与执行细节 `AgentEvent` MUST 分离。

#### Scenario: 用户消息落库
- **WHEN** 用户发送一条消息
- **THEN** 系统写入一条 role=user 的 `Message`

#### Scenario: 助手消息落库
- **WHEN** 一次 Run 完成并产出最终回答
- **THEN** 系统写入一条 role=assistant 的 `Message`，并关联到该 Run

### Requirement: 会话恢复
平台 SHALL 以数据库为对话事实源；用户隔较长时间重新进入会话时，对话历史 MUST 完整恢复，workspace 文件状态 SHALL 在快照可用时从快照恢复。

#### Scenario: 过期后重新进入
- **WHEN** 用户在沙箱已被回收后重新打开会话
- **THEN** 对话历史从数据库完整恢复，workspace 从最近快照 resume 重建（产生一次冷启动）

#### Scenario: 快照不可用时
- **WHEN** 重新进入会话但没有可用快照
- **THEN** 系统重建并重新初始化 workspace（文件状态从初始 demo repo 开始），对话历史仍完整

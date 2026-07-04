## ADDED Requirements

### Requirement: Thread 属于一个 Workspace
Thread MUST 属于且仅属于一个 workspace，不是 Better Auth session。Thread SHALL 拥有 messages 和 runs。

#### Scenario: Thread 详情包含 messages 和 runs
- **WHEN** 请求某 thread 的详情
- **THEN** 响应包含该 thread 下的全部 message 和 run 列表

#### Scenario: 跨用户访问被拒绝
- **WHEN** 用户 A 请求用户 B 拥有 workspace 下的 thread
- **THEN** 系统返回 FORBIDDEN 或 NOT_FOUND

### Requirement: Thread 归档策略
Thread SHALL 支持 `active`/`archived` 两态；归档后 MUST 拒绝启动新 run，但仍可读。

#### Scenario: 归档 thread 拒绝新 run
- **WHEN** 对状态为 `archived` 的 thread 创建 run
- **THEN** 系统拒绝并返回 WORKSPACE_ARCHIVED 或等价错误码，不创建 run 记录

### Requirement: Title 派生
创建 thread 时如未提供 title，SHALL 从 `initialPrompt` 派生；如两者都缺失，使用默认标题。

#### Scenario: 从 initialPrompt 派生标题
- **WHEN** 创建 thread 请求提供 `initialPrompt` 但未提供 `title`
- **THEN** 系统生成的 thread title 派生自 `initialPrompt` 的内容

#### Scenario: 两者都缺失时使用默认标题
- **WHEN** 创建 thread 请求既未提供 `title` 也未提供 `initialPrompt`
- **THEN** 系统使用固定默认标题

## ADDED Requirements

### Requirement: 任务提交与展示
Web UI SHALL 提供任务提交入口、agent 事件时间线与最终报告面板。

#### Scenario: 提交任务
- **WHEN** 用户在任务页输入自然语言任务并提交
- **THEN** 创建一个 run 并开始展示事件流

#### Scenario: 展示事件时间线
- **WHEN** run 正在运行
- **THEN** UI 展示模型步骤与工具调用事件，按 seq 顺序排列

#### Scenario: 展示最终报告
- **WHEN** run 完成
- **THEN** UI 在报告面板展示 Markdown 报告

### Requirement: 多轮对话界面
Web UI SHALL 以对话形式展示同一 Session 内的多轮消息；用户可在已有会话内继续追问。

#### Scenario: 继续追问
- **WHEN** 用户在一次 Run 完成后于同一会话输入新消息
- **THEN** UI 追加新一轮对话，并展示该轮的事件时间线与结果

#### Scenario: 重新进入会话
- **WHEN** 用户重新打开一个历史会话
- **THEN** UI 从数据库恢复完整对话历史并可继续对话

### Requirement: 邀请码门禁页
Web UI SHALL 在进入任务页前提供邀请码门禁。

#### Scenario: 门禁拦截
- **WHEN** 用户未通过邀请码校验
- **THEN** 无法进入任务页

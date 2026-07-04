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

### Requirement: 前端状态管理与实时同步
Web UI SHALL 采用"DB First, SSE Enhancement"双源合并策略，主流程通过 SSE 实时推送渲染，刷新/恢复场景从 DB 加载。

#### Scenario: 发送新消息（主流程）
- **WHEN** 用户输入消息并发送
- **THEN** UI 立刻乐观渲染用户消息
- **AND** 建立 SSE 连接到 `/api/runs/:runId/events`
- **AND** 所有后续渲染（工具调用、AI 回复）通过 SSE 事件推送
- **AND** SSE 完成后清除 activeRunId，不触发额外 GET session 请求

#### Scenario: 刷新页面（run 进行中）
- **WHEN** 用户刷新页面且当前 session 有 run 在 `running` 或 `provisioning_workspace` 状态
- **THEN** UI 从 GET session 拿到初始状态
- **AND** 检测到进行中的 run 后自动重连 SSE
- **AND** SSE 首条 `snapshot` 事件携带已落库的所有事件，前端无缝补齐历史

#### Scenario: 刷新页面（run 已完成）
- **WHEN** 用户刷新页面且当前 session 所有 run 已完成
- **THEN** UI 从 GET session 拿到完整数据
- **AND** 不建立 SSE 连接

#### Scenario: SSE 连接失败或断开
- **WHEN** SSE 连接失败或中途断开
- **THEN** UI 自动重连 3 次（间隔 2s/5s/10s）
- **AND** 3 次失败后降级到轮询（每 5s GET session 一次）
- **AND** 显示连接状态指示器："🟢 实时连接" / "🟡 轮询中（SSE 已断开）" / "🔴 离线"

#### Scenario: 浏览器休眠后恢复
- **WHEN** 浏览器从休眠/后台恢复（`visibilitychange` 事件）
- **AND** SSE 连接已断开
- **THEN** UI 自动重连 SSE

#### Scenario: 快速连发多条消息
- **WHEN** 用户在上一条消息 run 未完成时尝试发送新消息
- **THEN** 发送按钮禁用
- **AND** 显示"运行中"状态

#### Scenario: POST /runs 成功但 SSE 连不上
- **WHEN** POST `/api/sessions/:id/runs` 返回成功但 SSE 连接失败
- **THEN** UI 显示"任务已提交"
- **AND** 降级到轮询（每 5s GET session）

#### Scenario: Run 超时或取消
- **WHEN** SSE 推送 `run_timeout` 或 `run_cancelled` 事件
- **THEN** UI 显示相应状态（"任务超时" / "已取消"）
- **AND** 提供重试按钮（超时场景）

### Requirement: 邀请码门禁页
Web UI SHALL 在进入任务页前提供邀请码门禁。

#### Scenario: 门禁拦截
- **WHEN** 用户未通过邀请码校验
- **THEN** 无法进入任务页

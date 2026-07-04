## ADDED Requirements

### Requirement: Composer 状态由 derivedUiState 精确控制
Composer 的 submit 是否启用 MUST 根据 `derivedUiState` 精确判断,不是简单的"有 active run 就禁用"。`waiting_for_input` 状态下 submit MUST 启用,作为用户回答的唯一入口。判断逻辑 MUST 封装为共享 hook,桌面端和移动端共用同一份判断。

#### Scenario: 活跃执行中禁用 submit
- **WHEN** run 的 derivedUiState 为 `running`/`possibly_running`/`cancelling`
- **THEN** composer 的 submit 被禁用

#### Scenario: waiting_for_input 启用 submit
- **WHEN** run 的 derivedUiState 为 `waiting_for_input`
- **THEN** composer 的 submit 被启用,placeholder 显示引导性文案,上方展示问题提示条

#### Scenario: 终态启用 submit
- **WHEN** run 的 derivedUiState 为终态之一
- **THEN** composer 的 submit 被启用,允许开始新一轮对话

### Requirement: API State 是事实源
前端 SHALL 允许 optimistic state,但刷新后 MUST 始终能从 API snapshot 完整恢复,不依赖内存中的 SSE 状态。

#### Scenario: 刷新后从 snapshot 恢复
- **WHEN** 页面在 run 执行过程中被刷新
- **THEN** 重新加载后通过 API snapshot 恢复到与刷新前一致的状态

### Requirement: Artifact 是一等交付物
Artifact 在 UI 中 MUST 是一等能力,清晰展示创建中/创建完成/被打开/有版本历史四种状态,MUST 与 assistant message 和 workspace file 视觉区分。

#### Scenario: Artifact 预览卡片渲染
- **WHEN** run 产生 `artifact_created` 或 `artifact_updated` 事件
- **THEN** conversation 中渲染对应的 artifact 预览卡片

#### Scenario: 点击预览打开面板
- **WHEN** 用户点击 artifact 预览卡片
- **THEN** 右侧 artifact panel 打开并展示对应版本内容

## ADDED Requirements

### Requirement: Agent loop 编排
平台 SHALL 基于 Pi runtime 编排 agent loop：注入 system prompt、模型与工具，循环执行模型推理与工具调用，直至最终回答、失败或达到 `maxSteps`。

#### Scenario: Happy path
- **WHEN** 用户提交「找出所有 TODO 并生成报告」且模型脚本化为先调用 search_text 再给出最终回答
- **THEN** 至少发生一次 `search_text` 工具调用，生成 Markdown 报告 artifact，run 状态为 `completed`

#### Scenario: 工具执行失败
- **WHEN** agent 运行过程中发生系统级错误（如 sandbox 初始化失败）
- **THEN** run 状态变为 `failed` 并记录 error，已落事件保留

#### Scenario: 超过步数上限
- **WHEN** agent 运行超过 `maxSteps` 仍未给出最终回答
- **THEN** run 状态变为 `timeout`

### Requirement: LLM 集成与回退
平台 SHALL 通过 pi-ai 集成 OpenAI/Anthropic；当缺少 API key 时 MUST 回退到 faux provider，保证流程可运行。

#### Scenario: 无 key 回退
- **WHEN** 环境未配置任何 LLM API key
- **THEN** 系统使用 faux provider 运行，不抛缺 key 错误

### Requirement: Policy guard 挂载
工具调用 MUST 在执行前经过 policy guard（Pi 的 `beforeToolCall` 挂点）；被 guard 拒绝的调用 MUST 不触达 sandbox。

#### Scenario: guard 拦截
- **WHEN** policy guard 判定某次工具调用不被允许
- **THEN** 该调用被阻止执行，并作为错误结果返回模型

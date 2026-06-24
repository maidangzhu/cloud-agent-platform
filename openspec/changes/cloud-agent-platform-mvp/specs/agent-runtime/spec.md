## ADDED Requirements

### Requirement: Agent loop 编排
平台 SHALL 基于 Pi runtime 编排 agent loop：注入 system prompt、模型与工具，循环执行模型推理与工具调用，直至最终回答、失败或达到 `maxSteps`。

#### Scenario: Happy path
- **WHEN** 用户提交「找出所有 TODO 并生成报告」，真实 LLM 探索仓库并调用工具
- **THEN** 至少发生一次工具调用，生成 Markdown 报告 artifact，run 状态为 `completed`

#### Scenario: 工具执行失败
- **WHEN** agent 运行过程中发生系统级错误（如 sandbox 初始化失败、LLM 端点不可达）
- **THEN** run 状态变为 `failed` 并记录 error，已落事件保留

#### Scenario: 超过步数上限
- **WHEN** agent 运行超过 `maxSteps` 仍未给出最终回答
- **THEN** run 状态变为 `timeout`

#### Scenario: LLM 首响应超时后重试
- **WHEN** 单次 LLM stream 请求在 10 秒内没有产生首个 provider stream event
- **THEN** 平台 SHALL abort 该次请求并重试，最多重试 2 次
- **AND** 每次尝试 SHALL 写入 `llm_attempt_started` 事件
- **AND** 每次首响应超时 SHALL 写入 `llm_attempt_timeout` 事件，事件 payload 包含 `attempt` 与 `timeoutMs`

#### Scenario: LLM 重试后成功
- **WHEN** 某次重试在 10 秒内产生首个 provider stream event
- **THEN** 平台 SHALL 写入 `llm_attempt_succeeded` 事件
- **AND** agent loop SHALL 继续消费该次成功的 LLM stream

#### Scenario: LLM 首响应重试耗尽
- **WHEN** 初始尝试与 2 次重试均未在 10 秒内产生首个 provider stream event
- **THEN** run 状态 SHALL 变为 `timeout`
- **AND** 平台 SHALL 写入 `run_timeout` 事件与 `completedAt`
- **AND** run SHALL NOT 长期停留在 `running`

#### Scenario: 最终回答不再写 Artifact
- **WHEN** agent 成功产出最终回答
- **THEN** 平台 SHALL 写入 assistant Message 与 `run_completed`
- **AND** 平台 SHALL NOT 在主流程创建 Artifact 记录
- **AND** 平台 SHALL NOT 写入 `artifact_created` 事件

### Requirement: LLM 集成
平台 SHALL 通过 pi-ai 以 OpenAI 兼容协议（`openai-completions`）集成 LLM，`baseUrl` 可指向中转站；所有业务流程（含集成测试）一律连真实 LLM，不提供 mock 回退。

#### Scenario: 缺少 API key
- **WHEN** 环境未配置 `OPENAI_API_KEY`
- **THEN** `resolveModel()` 抛出明确错误，提示需配置真实 LLM 凭据

### Requirement: Policy guard 挂载
工具调用 MUST 在执行前经过 policy guard（Pi 的 `beforeToolCall` 挂点）；被 guard 拒绝的调用 MUST 不触达 sandbox。

#### Scenario: guard 拦截
- **WHEN** policy guard 判定某次工具调用不被允许
- **THEN** 该调用被阻止执行，并作为错误结果返回模型

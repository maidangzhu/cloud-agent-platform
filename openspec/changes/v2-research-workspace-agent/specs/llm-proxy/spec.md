## ADDED Requirements

### Requirement: Provider 凭证不进沙箱
LLM provider 长期凭证 MUST 只由 Control Plane 持有；sandbox MUST 通过 `POST /api/llm-proxy` 使用 scoped run token 间接调用模型。

#### Scenario: 缺少 token 的请求被拒绝
- **WHEN** 调用 llm-proxy 端点但未提供 scoped run token
- **THEN** 请求返回 401

#### Scenario: 终态 run 拒绝新的 LLM 调用
- **WHEN** 使用已终态 run 的 token 调用 llm-proxy
- **THEN** 请求返回 RUN_TERMINAL

### Requirement: finish_reason 归一化
不同 LLM provider 的语义边界信号（如 finish_reason）MUST 被归一化为统一的内部值，供 sandbox 判断"这段内容已完整"以触发攒批落库。

#### Scenario: 不同 provider 的完成信号被归一化
- **WHEN** 两个不同 provider 用不同字段表达"生成完成"
- **THEN** llm-proxy 响应中呈现统一的归一化信号，sandbox 不需要处理 provider 差异

### Requirement: 用量记录
每次 LLM 调用 MUST 记录一条 `LLMUsageRecord`（provider/model/token 用量/首字节延迟/耗时），记录 MUST NOT 影响 run 是否可以继续执行——不存在因用量拒绝执行的路径。

#### Scenario: 调用后产生用量记录
- **WHEN** llm-proxy 完成一次调用
- **THEN** 产生一条包含 provider/model/tokens/durationMs 的 LLMUsageRecord

#### Scenario: 用量不阻塞执行
- **WHEN** 某 run 已经产生大量 LLMUsageRecord
- **THEN** 该 run 仍可继续调用 llm-proxy，不因累计用量被拒绝

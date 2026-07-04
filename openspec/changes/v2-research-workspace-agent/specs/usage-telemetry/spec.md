## ADDED Requirements

### Requirement: 纯观测,无强制执行
用量记录（`LLMUsageRecord`）MUST 是纯观测数据,append-only,MUST NOT 产生任何"拒绝执行"的业务后果。系统 MUST NOT 存在余额、额度或"用量不足拒绝启动 run"的判断路径。

#### Scenario: 用量记录不影响 run 创建
- **WHEN** 用户已产生大量历史用量记录后再次创建 run
- **THEN** run 创建正常成功，不检查任何余额或额度

#### Scenario: 用户只能查看自己的用量记录
- **WHEN** 用户 A 查询用量记录列表
- **THEN** 只返回归属于用户 A 拥有 workspace 下 run 产生的记录

### Requirement: 按维度查询
用量记录查询端点 SHALL 支持按 runId/provider/model 过滤，并支持分页。

#### Scenario: 按 runId 过滤
- **WHEN** 查询用量记录并指定 runId
- **THEN** 只返回该 run 产生的记录

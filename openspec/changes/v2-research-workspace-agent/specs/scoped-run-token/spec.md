## ADDED Requirements

### Requirement: Token 绑定与隔离
Scoped run token MUST 绑定 userId/workspaceId/threadId/runId 与过期时间，MUST NOT 被用于其他 run 或 workspace。

#### Scenario: 正确 token 通过校验
- **WHEN** 使用某 run 签发的合法 token 调用该 run 的 ingest 端点
- **THEN** 请求通过认证

#### Scenario: 跨 run 使用被拒绝
- **WHEN** 使用 run A 的 token 调用 run B 的 ingest 端点
- **THEN** 请求返回 RUN_TOKEN_INVALID

#### Scenario: 过期 token 被拒绝
- **WHEN** 使用已过期的 token 调用 ingest 端点
- **THEN** 请求返回 RUN_TOKEN_INVALID

### Requirement: Sandbox 无法直接访问数据库或用户凭证
Sandbox MUST NOT 拿到 database URL、Better Auth cookie、长期用户 token 或长期 LLM provider key；只能拿到 scoped run token。

#### Scenario: Runner 环境变量不含 DB 凭证
- **WHEN** 检查 sandbox runner 进程的环境变量
- **THEN** 不存在任何数据库连接字符串或 Better Auth session cookie

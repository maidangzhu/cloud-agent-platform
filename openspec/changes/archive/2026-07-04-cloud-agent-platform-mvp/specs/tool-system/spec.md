## ADDED Requirements

### Requirement: 受控工具集
平台 SHALL 提供 `list_files / read_file / search_text / write_file / run_command` 五个工具，每个工具 MUST 声明参数 schema，调用前 MUST 通过 schema 校验。

#### Scenario: 未注册工具被拒绝
- **WHEN** agent 请求调用未注册的工具名
- **THEN** 调用被拒绝

#### Scenario: 参数不合 schema 被拒绝
- **WHEN** agent 调用工具但参数不符合其 schema
- **THEN** 调用被拒绝，错误作为工具结果返回供模型重试

#### Scenario: 搜索命中
- **WHEN** 对包含 TODO 的 workspace 调用 `search_text` 搜索 TODO
- **THEN** 返回命中文件路径、行号与内容摘要

### Requirement: 命令执行约束
`run_command` MUST 受命令白名单约束，高风险命令默认拒绝，且 MUST 设置超时与输出长度截断。

#### Scenario: 高风险命令被拒绝
- **WHEN** agent 请求执行高风险命令（如 `rm -rf /`、网络访问、sudo）
- **THEN** 调用被标记为 `rejected`，不实际执行

#### Scenario: 命令超时
- **WHEN** 执行的命令超过超时时长
- **THEN** 返回 timeout 结果而非无限等待

#### Scenario: 输出截断
- **WHEN** 命令输出超过长度上限
- **THEN** 输出被截断并标记 truncated

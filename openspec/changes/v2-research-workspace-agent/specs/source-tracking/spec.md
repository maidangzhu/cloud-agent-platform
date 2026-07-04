## ADDED Requirements

### Requirement: Source 记录证据链
Source SHALL 属于一个 workspace，可选关联一个 run 和/或一个 artifact。`fetch_url`/`web_search` 产生的每条结果 MUST 记录为 Source，无论是否被最终引用于报告——这是证据链完整性要求。

#### Scenario: fetch_url 结果始终记录为 Source
- **WHEN** agent 调用 `fetch_url` 抓取一个网页，无论抓取结果是否被写入报告
- **THEN** 系统记录一条 `kind=url` 的 Source

#### Scenario: Artifact 可引用 Source
- **WHEN** 查询一个 artifact 的详情
- **THEN** 响应包含该 artifact 引用的 Source 列表

#### Scenario: 按 workspace 或 run 查询 Source
- **WHEN** 请求某 workspace 或某 run 下的 Source 列表
- **THEN** 只返回属于该 workspace/run 的 Source

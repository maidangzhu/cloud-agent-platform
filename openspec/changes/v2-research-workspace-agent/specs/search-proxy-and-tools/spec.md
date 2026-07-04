## ADDED Requirements

### Requirement: Search Proxy 代理 web_search
`web_search` 工具 MUST 经 `POST /api/search-proxy` 代理，search provider key MUST NOT 进入沙箱。网络失败/5xx MUST 重试最多 2 次（指数退避）；4xx MUST NOT 重试。

#### Scenario: 5xx 失败重试后成功
- **WHEN** search provider 连续返回一次 5xx 后第二次成功
- **THEN** 工具调用最终标记为 completed，且重试次数不超过 2 次

#### Scenario: 4xx 不重试直接失败
- **WHEN** search provider 返回 4xx
- **THEN** 工具调用立即标记为 failed，不发起重试

#### Scenario: 搜索结果记录为 Source
- **WHEN** web_search 返回结果列表
- **THEN** 每条结果被记录为 `kind=search_result` 的 Source

### Requirement: fetch_url 的 SSRF 防护
`fetch_url` 工具 MUST 拒绝访问 localhost、私有网段（10.x/172.16.x/192.168.x/169.254.x）以及云 metadata 地址。拦截命中 MUST 判定为 `rejected`（policy 拦截），MUST NOT 判定为 `failed`。

#### Scenario: 拒绝访问私有网段
- **WHEN** fetch_url 请求的目标地址属于私有 CIDR 范围
- **THEN** 工具调用被判定为 rejected，不发起任何网络请求

#### Scenario: 拒绝访问云 metadata 地址
- **WHEN** fetch_url 请求的目标地址是云 metadata 服务地址
- **THEN** 工具调用被判定为 rejected

### Requirement: fetch_url 的重试与截断
网络级失败（connect timeout/DNS 失败/5xx）MUST 重试最多 1 次；4xx MUST NOT 重试。内容超过大小限制 MUST 被截断并标记 `truncated: true`。每次抓取无论是否成功引用 MUST 记录为 Source。

#### Scenario: 网络失败重试一次后成功
- **WHEN** 第一次请求超时，第二次请求成功
- **THEN** 工具调用最终标记为 completed

#### Scenario: 内容超限被截断
- **WHEN** 抓取到的网页内容超过大小上限
- **THEN** 内容被截断，响应标记 `truncated: true`

#### Scenario: 抓取始终记录 Source
- **WHEN** fetch_url 完成一次抓取，无论内容是否最终被使用
- **THEN** 产生一条 `kind=url` 的 Source 记录

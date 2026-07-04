## ADDED Requirements

### Requirement: 邀请码服务端校验
平台 SHALL 在创建 run 前校验邀请码，且校验 MUST 在服务端进行，前端通过状态不可作为唯一依据。

#### Scenario: 缺少邀请码
- **WHEN** 请求未携带邀请码调用创建 run
- **THEN** 系统返回未授权错误，不创建 run

#### Scenario: 错误邀请码
- **WHEN** 请求携带无效邀请码
- **THEN** 系统返回未授权错误，不创建 run

#### Scenario: 正确邀请码
- **WHEN** 请求携带服务端配置中存在的邀请码
- **THEN** 系统允许创建 run

#### Scenario: 前端通过不算数
- **WHEN** 前端本地标记已通过但请求未携带有效邀请码
- **THEN** API 仍返回未授权错误

## ADDED Requirements

### Requirement: Workspace 是授权边界
每个 workspace-scoped 业务表 SHALL 携带 `workspaceId`，所有跨用户访问 MUST 被拒绝。P0 下用户只能访问自己拥有的 workspace。

#### Scenario: 用户只能看到自己的 workspace
- **WHEN** 用户 A 请求 workspace 列表
- **THEN** 系统只返回 `ownerUserId` 等于用户 A 的 workspace

#### Scenario: 跨用户读取被拒绝
- **WHEN** 用户 A 请求用户 B 拥有的 workspace 详情
- **THEN** 系统返回 FORBIDDEN 或 NOT_FOUND，不泄露该 workspace 存在的信息

### Requirement: Workspace 归档策略
Workspace SHALL 支持 `active`/`archived` 两态；归档 MUST 优先于硬删除。归档后的 workspace MUST 拒绝创建新 thread 或 run，但仍可读。

#### Scenario: 归档 workspace 拒绝新建 thread
- **WHEN** 对状态为 `archived` 的 workspace 发起创建 thread 请求
- **THEN** 系统拒绝并返回 WORKSPACE_ARCHIVED，不创建任何记录

#### Scenario: 归档 workspace 仍可读
- **WHEN** 请求已归档 workspace 的详情
- **THEN** 系统正常返回该 workspace 的数据

#### Scenario: 归档判断与创建操作之间无竞态窗口
- **WHEN** 并发的归档请求和创建 run 请求同时到达同一个 workspace
- **THEN** 系统通过条件原子 insert-select 判定，不存在"先查到 active、再创建成功但 workspace 实际已被归档"的中间状态

### Requirement: Title 校验
创建或更新 Workspace 的 title MUST 非空且经过 trim。

#### Scenario: 拒绝空 title
- **WHEN** 创建 workspace 请求的 title 为空字符串或纯空白
- **THEN** 系统拒绝并返回 VALIDATION_FAILED

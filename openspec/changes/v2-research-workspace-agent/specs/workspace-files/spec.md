## ADDED Requirements

### Requirement: Path Guard
Workspace file path MUST 经过规范化，MUST NOT 逃逸 workspace root。路径穿越尝试 MUST 被拒绝。

#### Scenario: 拒绝路径穿越
- **WHEN** ingest 文件请求的 path 包含 `../` 试图逃逸 workspace root
- **THEN** 请求返回 VALIDATION_FAILED，不写入任何文件

#### Scenario: 合法相对路径被规范化
- **WHEN** ingest 文件请求的 path 是合法的相对路径
- **THEN** 路径被规范化后正常写入

### Requirement: 文件元数据必须完整
Workspace file 元数据 MUST 包含 `contentHash` 和 `size`。按 `(workspaceId, path)` upsert，重复写入同一路径更新而非重复创建。

#### Scenario: 相同路径重复写入更新而非重复
- **WHEN** 对同一个 `(workspaceId, path)` 连续 ingest 两次文件
- **THEN** 第二次是更新操作，不产生第二条独立记录

### Requirement: 内容存储策略
小文本内容 SHALL 直接存入数据库 `content` 字段；超过 size 限制的内容 MUST 使用对象存储并设置 `storageKey`。

#### Scenario: 大内容要求 storageKey
- **WHEN** ingest 文件请求的内容超过 inline 存储上限且未提供 `storageKey`
- **THEN** 请求返回 VALIDATION_FAILED

### Requirement: 刷新后可恢复
Workspace file 内容 MUST 能从数据库恢复，不依赖 sandbox 内存或磁盘状态。

#### Scenario: 文件在页面刷新后仍可读
- **WHEN** fake runner 写入一个 workspace file 并 ingest 后，页面刷新重新请求文件内容
- **THEN** 返回的内容与 ingest 时一致，不因 sandbox 已销毁而丢失

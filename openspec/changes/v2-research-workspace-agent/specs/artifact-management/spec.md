## ADDED Requirements

### Requirement: Artifact 必须可恢复
Artifact MUST 属于一个 workspace 和一个 run，MUST 有 `title`、`kind`，且 MUST 能从 `contentSnapshot`、`storageKey`，或一个合法的 workspace file path 恢复内容。缺少可恢复内容的创建请求 MUST 被拒绝。

#### Scenario: 缺少可恢复内容被拒绝
- **WHEN** ingest artifact 请求既未提供 `contentSnapshot`、`storageKey`，也未提供合法的 file path
- **THEN** 请求返回 VALIDATION_FAILED

#### Scenario: Artifact 不因源文件变化而失效
- **WHEN** artifact 引用的 workspace file 之后被覆盖或删除
- **THEN** artifact 通过其保存的 `contentSnapshot`/`storageKey` 仍可完整恢复

### Requirement: Artifact 版本化
已存在的 `artifactId` 再次 ingest MUST 产生新版本（version 原子递增），旧版本 MUST 仍可读。版本历史查询端点即使只有单版本也 MUST 返回长度为 1 的数组，保持响应形状稳定。

#### Scenario: 新版本创建后旧版本仍可读
- **WHEN** 对已存在的 artifact 再次 ingest 产生新版本
- **THEN** 新版本可读，且旧版本通过版本历史查询仍可完整访问

#### Scenario: 版本号原子递增
- **WHEN** 并发对同一个 artifact 发起两次版本更新
- **THEN** 版本号分配不重复、不跳号，两次更新各自获得正确的连续版本号

### Requirement: 跨用户隔离
用户 MUST NOT 读取其他用户 workspace 下的 artifact。

#### Scenario: 跨用户读取被拒绝
- **WHEN** 用户 A 请求用户 B 拥有 workspace 下的 artifact
- **THEN** 系统返回 FORBIDDEN 或 NOT_FOUND

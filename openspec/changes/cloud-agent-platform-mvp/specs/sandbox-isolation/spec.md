## ADDED Requirements

### Requirement: 统一沙箱接口
平台 SHALL 通过统一 `Sandbox` 接口访问文件系统与命令执行；P0 提供唯一实现 `VercelSandbox`（`@vercel/sandbox`，Firecracker microVM），业务测试与生产共用真实沙箱。接口保留抽象以便未来接入其它隔离后端。

#### Scenario: 沙箱可读写
- **WHEN** 在沙箱内写入再读取一个 workspace 内文件
- **THEN** 读到的内容与写入一致

#### Scenario: workspace 初始化
- **WHEN** 为一个 run 初始化 workspace 并注入 demo 文件
- **THEN** demo 文件出现在 workspace 内且可被工具访问

### Requirement: Workspace 复用与快照恢复
同一 Session 的多次 Run SHALL 复用同一 workspace；workspace 通过命名沙箱 `getOrCreate` 实现「活着复用、回收则重建」，并 SHALL 支持在停止前快照、重新进入时从快照恢复。

#### Scenario: 沙箱存活时复用
- **WHEN** 同一 Session 第二次 Run 开始且其命名沙箱仍存活
- **THEN** 直接复用该沙箱，第一次 Run 写入的文件仍可见

#### Scenario: 沙箱回收后从快照恢复
- **WHEN** 同一 Session 重新进入但命名沙箱已被回收，且存在可用快照
- **THEN** 从快照 resume 重建 workspace，文件状态恢复，并记录恢复事件

#### Scenario: 无快照时重建
- **WHEN** 命名沙箱已回收且无可用快照
- **THEN** 重建并重新初始化 workspace（从初始 demo repo 开始），不报错

### Requirement: 路径越权防护
所有文件操作的路径 MUST 归一化并限制在 workspace 内；任何越出 workspace 的路径 MUST 被拒绝。

#### Scenario: 相对路径越权
- **WHEN** 请求读取 `../secret` 这类越出 workspace 的路径
- **THEN** 操作被拒绝

#### Scenario: 绝对路径越权
- **WHEN** 请求读写 workspace 之外的绝对路径
- **THEN** 操作被拒绝

#### Scenario: 合法路径放行
- **WHEN** 请求访问 workspace 内的相对路径
- **THEN** 操作被允许并解析为 workspace 内的绝对路径

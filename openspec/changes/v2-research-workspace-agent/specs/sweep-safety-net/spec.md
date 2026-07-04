## ADDED Requirements

### Requirement: 绝不允许 Run 永久停留在非终态
系统级不变量：没有任何 run 允许永久停留在非终态。Sweep MUST 定时触发（Vercel Cron），最坏收敛延迟等于 cron 间隔。

#### Scenario: created 状态的 run 异步点火失败也会被收敛
- **WHEN** run 处于 `created` 状态但异步启动 sandbox 的操作失败，且没有任何后续状态转移发生
- **THEN** sweep 最终将其收敛到 `failed` 或 `timeout`，不会永久停留在 `created`

### Requirement: 扩大范围到孤儿资源清理
Sweep 职责 SHALL 不只覆盖卡死的 run,还 SHALL 清理孤儿 SandboxInstance(warm/ready 但无活跃 run 引用)和过期的 Redis stream key。

#### Scenario: 孤儿沙箱被清理
- **WHEN** 某 SandboxInstance 长期 warm 且无任何非终态 run 的 currentRunId 指向它
- **THEN** sweep 将其停止并回收

#### Scenario: 过期 stream key 被清理
- **WHEN** 某 run 的 Redis stream key 已超过清理宽限期
- **THEN** sweep 删除该 key

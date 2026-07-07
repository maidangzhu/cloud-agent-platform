## ADDED Requirements

### Requirement: SandboxInstance 复用互斥
`SandboxInstance` MUST 携带 `currentRunId` 字段标记当前占用者；认领可复用（`warm`/`ready`）实例 MUST 通过条件原子 UPDATE（`WHERE status IN ('warm','ready') AND current_run_id IS NULL`）完成，不允许两个并发请求同时认领同一个实例。

#### Scenario: 并发认领只有一方成功
- **WHEN** 两个并发的 run 创建请求同时尝试认领同一个 workspace 下的 warm SandboxInstance
- **THEN** 只有一个请求认领成功并获得该实例，另一个请求走"创建新沙箱"分支

#### Scenario: Run 结束后释放占用
- **WHEN** run 进入终态或 `waiting_for_input`
- **THEN** 对应 SandboxInstance 的 `currentRunId` 被原子清空

### Requirement: Sandbox 不直接写数据库
Sandbox runner 的一切持久化事实 MUST 通过 ingest HTTP API 上报，不允许直接连接数据库。

#### Scenario: Runner 完成生命周期全部经由 HTTP
- **WHEN** fake runner 执行心跳、事件、文件、artifact 上报的完整生命周期
- **THEN** 全部通过 ingest API 完成，runner 进程中不存在任何数据库客户端连接

### Requirement: Run 创建后自动启动真实 Sandbox Runner
产品主路径 MUST 在 run 创建后自动启动真实 Vercel Sandbox runner，不允许要求人工或测试 helper 手动调用 runner，也不允许以 fake/local sandbox 作为产品主路径。测试可以用 deterministic LLM 输出稳定断言，但 sandbox 运行边界必须是真实 Vercel Sandbox。

#### Scenario: 创建 run 后启动 agent loop
- **WHEN** 浏览器创建 run
- **THEN** Control Plane 将 run 从 `created` 推进到 `provisioning_sandbox`，签发 scoped run token，认领/创建 workspace sandbox，并在 sandbox 内启动 agent loop

#### Scenario: Runner 通过 ingest 驱动 SSE
- **WHEN** sandbox agent loop 开始执行
- **THEN** 浏览器 SSE 能看到 snapshot、runner/run 事件、`agent_message` 或 `stream_chunk`，以及终态或等待态

### Requirement: 孤儿资源清理
Sweep SHALL 定期清理孤儿 SandboxInstance（`warm`/`ready` 但无对应活跃 run，或对应 run 已终态但状态未跟着收敛）。

#### Scenario: 孤儿 SandboxInstance 被回收
- **WHEN** 某 SandboxInstance 长期处于 `warm` 状态且没有任何非终态 run 引用它
- **THEN** sweep 将其状态转为 `stopped` 并释放对应资源

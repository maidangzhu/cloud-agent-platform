## ADDED Requirements

### Requirement: Token 转发不落库
Sandbox 逐字产生的 LLM token MUST 通过独立通道（`POST /api/ingest/stream-chunk` → Redis `XADD`）转发，转发路径 MUST NOT 写入数据库；与"语义完整时落库"（`POST /api/ingest/events`）的路径完全解耦、互不阻塞。

#### Scenario: Stream chunk 不产生 AgentEvent 记录
- **WHEN** sandbox 通过 stream-chunk 端点转发一个 token
- **THEN** 数据库中不产生任何新的 AgentEvent 行

#### Scenario: 转发路径与落库路径独立
- **WHEN** 转发通道因 Redis 故障暂时不可用
- **THEN** 业务事实的落库（tool_call/file/artifact/终态事件）不受影响，仍正常写入

### Requirement: Cursor 续读语义
SSE 消费端 MUST 支持从 cursor 位置续读：新连接从 stream 起始位置（`"0"`）读取全部存量 chunk；重连时使用 `Last-Event-ID` header 作为 cursor 从该位置继续读取，不重复、不丢失。

#### Scenario: 新连接读取存量 chunk
- **WHEN** 一个新的 SSE 连接建立，run 已经有若干 chunk 被写入 stream 但此前无人订阅
- **THEN** 新连接能读到全部存量 chunk

#### Scenario: 重连不丢失也不重复
- **WHEN** 客户端网络中断后使用 `Last-Event-ID` 重新建立 SSE 连接
- **THEN** 从该 cursor 之后的全部 chunk 被正确接收，此前已收到的 chunk 不重复接收

### Requirement: 过期 Stream 清理
Redis stream key MUST 设置 TTL 或长度上限（`MAXLEN`），run 进入终态一段时间后 MUST 被 sweep 清理，防止无限增长。

#### Scenario: 终态 run 的 stream 最终被清理
- **WHEN** run 进入终态且经过清理宽限期
- **THEN** sweep 清理对应的 Redis stream key

### Requirement: 终态 Run 拒绝新 Chunk
向终态或 `waiting_for_input` run 转发 chunk 的请求 MUST 被拒绝。

#### Scenario: 终态 run 拒绝新 chunk
- **WHEN** 向已处于 `completed` 的 run 调用 stream-chunk 端点
- **THEN** 请求被拒绝

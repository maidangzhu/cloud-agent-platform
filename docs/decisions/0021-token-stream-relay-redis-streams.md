# ADR-0021：Token 转发原语从 Redis Pub/Sub 改为 Redis Streams + cursor

**状态：** 已接受（2026-07-03）。**修正（不是推翻）[ADR-0016](./0016-token-stream-relay-redis-pubsub.md)**——引入 Redis 做跨实例转发这个核心结论不变，变的是转发原语的具体选型。

## 决策

ADR-0016 用 Redis pub/sub 解决"沙箱和前端 SSE 可能在不同实例"的跨实例转发问题，但 pub/sub 有一个自己在文档里承认的结构性缺陷：**不持久化消息，发布那一刻没有订阅者在听，消息就永久丢失**。这不是理论风险，两个具体场景会真实触发：

1. **建连竞态**：run 刚启动，sandbox 已经开始 `PUBLISH` 第一批 token，但前端 SSE 请求还没来得及 `SUBSCRIBE`——这几百毫秒的 token 永久丢失。
2. **重连空洞**：用户网络抖动，`EventSource` 自动重连，重连期间 sandbox 仍在 `PUBLISH`，这段 token 也丢失。ADR-0016 自己在"未覆盖问题"里承认这需要 `Last-Event-ID` 机制，但当时没有正式设计。

改用 **Redis Streams**，用 entry ID 天然充当 cursor：

```text
沙箱侧：XADD run:{runId}:stream * chunk "<token>" type "thinking"
        —— 每条 entry 自动获得单调递增 ID（如 "1720000000123-0"），这个 ID 就是 cursor

SSE 侧：维护一个 cursor 变量
        - 新连接：从 "0" 开始读（stream 起始），能读到 sandbox 已写入但还没人读过的全部历史 chunk
        - 重连：浏览器标准的 Last-Event-ID header 就是上次收到的 cursor，
          从这个 ID 之后继续 XREAD，不重复、不丢失
        XREAD BLOCK 5000 STREAMS run:{runId}:stream <cursor>
        每读到一批 entry，转发给前端，同时把 cursor 更新为读到的最后一个 ID
```

这堵住了 ADR-0016 遗留的两个洞：

- 建连竞态消失——新连接不依赖"订阅时机刚好对上发布时机"，而是从 cursor 位置主动拉取。
- 重连空洞消失——`Last-Event-ID` 直接映射为 Streams cursor，是标准 SSE 重连机制和 Streams 读取模型的天然契合，不需要另外发明协议。
- 顺序保证更强——Streams entry ID 本身单调递增，是结构性保证，不依赖多订阅者/多发布方并发下的"大概率不乱"。

## 不引入的复杂度（避免过度设计）

- **不使用 consumer group（`XREADGROUP`）**。Consumer group 解决的是"多个 worker 竞争消费、需要 ack/重新分配"的场景；这里即使同一个 run 被多个浏览器 tab 同时看，每个 tab 也是独立维护自己的 cursor 各读各的，普通 `XREAD` 足够。
- **Stream 不是持久事实源**，短生命周期缓冲：`XADD` 时用 `MAXLEN ~1000` 限制单个 run 的 entry 数上限；对 stream key 设 TTL（`maxDurationSec` + 心跳宽限期，run 终态后一段时间过期）。这条清理并入 [ADR-0015](./0015-usage-telemetry-and-ops-priorities.md) 已扩大范围的 sweep job（孤儿 Redis stream 和孤儿沙箱是同类"占用即计费/占用即噪音"问题）。
- 转发路径依然不落库，依然和"语义完整落库"（[ADR-0011](./0011-dual-channel-streaming.md)/[ADR-0017](./0017-token-accumulation-and-persistence-timing.md)）那条独立路径解耦——变的只是"沙箱到前端"这一段中间层用什么原语，不是重新设计整个双通道模型。

## 端点契约调整

`agent-runtime-protocol.md` 新增的沙箱调用端点 `POST /api/ingest/stream-chunk`（转发用，不落库），内部实现改为 `XADD` 而不是 `PUBLISH`：

```json
{
  "chunk": "<token 文本>",
  "streamType": "thinking" | "content"
}
```

SSE 端（`GET /api/runs/:runId/events`）读取规则：有 `Last-Event-ID` header 就从该 ID 之后 `XREAD` 续读；没有则从 stream 起始（`"0"`）读取。

## P0/P1 排期

**本 ADR 确定 P0 直接实现 Streams 方案**（不是留到 P1）——这是这轮讨论明确拍板的决定：技术方案已验证可行（见 memory 记录的 Redis PoC，`XADD`/`XREAD`/cursor 续读均已在真实 Upstash 实例上验证通过），且比降级方案（DB 轮询）更贴近最终产品体验，不需要先做一个将来要整体替换的降级版本。

## 背景

三天前 ADR-0016 拍板时，"P0 是否真做 token 级实时，还是继续走降级路线"被明确标记为"留给用户单独拍板"的排期问题。这轮讨论中用户描述了自己过去用"每个 SSE event 直接落库、前端轮询数据库"的土办法解决过同类问题，并转述前同事提到的"流写 Redis、接口读 Redis、用 cursor 保证同步"方案——这精确对应 Redis Streams 的设计，比 pub/sub 更适合这个场景，因此在这轮排期判断中直接选定为 P0 方案，同时修正 ADR-0016 的具体机制选型。

## 被否方案

- **继续用 pub/sub，P0 先接受"偶尔丢几个 token"的降级体验**：ADR-0016 原本论证"token 流可重放可丢，丢几个不影响正确性"，这个论证成立的前提是"事实源仍然是落库路径"——但用户体验层面，建连竞态会导致每次新 run 开始的第一段话丢字，这是一个会被频繁注意到的体验瑕疵，不是可以忽略的边缘情况；Streams 方案成本增量很小（多一个 cursor 变量），没有理由不做。
- **DB 轮询（用户提到的"土办法"）**：延迟锁定在轮询间隔上，且轮询会比正常业务查询更快打满数据库连接（呼应 ADR-0015 已知但推后的连接池问题）。这个方案在没有 Redis 可用的环境下是合理兜底，但当前项目已经验证 Redis 可用，没有必要退回更差的方案。

## 连锁影响

- `agent-runtime-protocol.md`：新增 §6.x `POST /api/ingest/stream-chunk` 端点契约（内部 `XADD`）；§3 端到端顺序需要补充"前端 SSE 处理函数订阅前先从 stream 起始位置拉取存量 entry"这一步。
- `api-contract.md`：SSE 端点实现细节新增"读取 `Last-Event-ID`，决定 `XREAD` 起始 cursor"。
- Redis 成为 P0 新增外部依赖（已装 `ioredis@5.11.1`，已通过 PoC 验证 Upstash 实例连通性），需要在部署清单和环境变量清单补充 `REDIS_URL`。
- sweep job 职责范围新增"清理过期 Redis stream key"（挂在 [ADR-0015](./0015-usage-telemetry-and-ops-priorities.md) 已扩大的 sweep 职责下，不单独开新 job）。
- [ADR-0016](./0016-token-stream-relay-redis-pubsub.md) 状态保持"已接受"，补充一条指向本 ADR 的"更新"说明（核心结论——引入 Redis 做跨实例转发——不变，机制细节由本 ADR 修正）。
- `docs/decisions/OPEN-QUESTIONS.md`：DQ-2 已经是"已解决"状态（链接 ADR-0016），追加说明具体机制已被本 ADR 修正为 Streams，且"建连竞态/重连空洞"这个未覆盖问题已解决。

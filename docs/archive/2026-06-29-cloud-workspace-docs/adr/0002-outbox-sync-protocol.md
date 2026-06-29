# ADR-0002：Sandbox ↔ Control Plane 同步协议（Outbox + Ingest + Ack）

- 状态：已采纳
- 日期：2026-06-28
- 依赖：ADR-0001
- 关键词：outbox、idempotent ingest、ack offset、WAL、exactly-once effect

## 背景

ADR-0001 把 agent loop 放进 sandbox，但 sandbox 不能直接写 Postgres。需要一个协议把 sandbox 内的状态变化同步到 control plane。

朴素方案"agent 写完事件 → HTTP POST 到 server"是**不受控双写**：

| 故障 | 后果 |
|---|---|
| 网络断 | 本地有，DB 无 |
| server 5xx | sandbox 重试 → 顺序乱 |
| sandbox 进程被杀 | 本地丢一半，不知道哪些已同步 |
| 客户端时钟漂移 | event 顺序在 DB 里和实际不一致 |

正确做法：**Local Outbox + Idempotent Ingest + Ack Offset** —— 三件套缺一不可。

## 决定

### 三层数据模型

```
Sandbox 内部（.agent/ 目录）
  session.sqlite      ← Runtime transcript（agent 恢复用，DB 是镜像）
    messages, tool_calls, plan_state, pending_approvals
  outbox.sqlite       ← 待发事件队列
    seq, event_id, type, payload, acked, acked_at
  forwarder           ← 守护进程：批量 POST 到 control plane

Control Plane（Postgres）
  agent_events        ← 事实源
  runs                ← run 状态机
  tool_calls          ← 工具调用索引
  artifacts           ← agent 产出
  memory_proposals    ← memory 草稿
  skill_proposals     ← skill 草稿
```

### Sandbox 内 local transaction（核心）

```sql
-- sandbox 内 sqlite，agent 每产生一个事件：
BEGIN;
  INSERT INTO events_outbox (seq, event_id, type, payload, acked, created_at)
    VALUES (?, ?, ?, ?, 0, ?);
  -- 可能同时 INSERT INTO messages / tool_calls（同事务）
COMMIT;

-- 异步 forwarder 轮询 acked=0，批量 POST
SELECT * FROM events_outbox WHERE acked=0 ORDER BY seq LIMIT 100;
```

**强保证**：seq 在 sandbox 内单调递增；同 seq 重试幂等；本地事务保证 outbox 写成功 = 状态已记录。

### Event schema（sandbox → control plane）

```json
{
  "event_id": "run_456:42",
  "workspace_id": "ws_123",
  "session_id": "sess_789",
  "run_id": "run_456",
  "seq": 42,
  "type": "tool_call_completed",
  "actor": "agent:run_456",
  "payload": {
    "tool_call_id": "tc_001",
    "name": "write_file",
    "result": { "bytes": 1234 }
  },
  "created_at": "2026-06-28T13:21:56.948Z"
}
```

**`event_id` = `${run_id}:${seq}`**：天然唯一，sandbox 端不必再生成 UUID。

### Ingest API（control plane → DB）

```
POST /api/events/ingest
Headers:
  Authorization: Bearer <scoped run token>
Body:
  { "events": [ {...}, {...} ] }

Response:
  {
    "acked_through_seq": 42,
    "missing_seq": [10, 11, 12]   // 服务端发现的洞，sandbox 补传
  }
```

DB 写入（伪 SQL）：

```sql
BEGIN;
  INSERT INTO agent_events
    (id, workspace_id, session_id, run_id, seq, type, actor, payload, created_at)
  VALUES (...)
  ON CONFLICT (id) DO NOTHING;        -- 幂等
  -- 顺便落 runs.last_acked_seq
  UPDATE runs SET last_acked_seq = GREATEST(last_acked_seq, $max_seq)
    WHERE id = $run_id;
COMMIT;
```

**`UNIQUE(run_id, seq)` 和 `PRIMARY KEY (id)` 双重保险**。

### Forwarder 行为

```
forwarder loop:
  batch = SELECT * FROM outbox WHERE acked=0 ORDER BY seq LIMIT 100
  if batch empty: sleep 500ms, continue
  try:
    resp = POST /api/events/ingest { events: batch }
    UPDATE outbox SET acked=1, acked_at=now() WHERE seq <= resp.acked_through_seq
    if resp.missing_seq not empty:
      log.warn("server reported missing seq, will resend")
      -- 那些 seq 实际还在 outbox（acked=0），下次 batch 自然带上
  except network/5xx:
    sleep backoff(1s, 2s, 5s, 10s, 30s)
    continue
  except 4xx (token 失效 / 权限):
    stop forwarder, alert operator
```

### Ack Offset 持久化

`runs.last_acked_seq` 是 server 视角的"sandbox 已确认收到的最大 seq"。

- sandbox 启动时：先 `SELECT MAX(seq) FROM outbox WHERE acked=1`，从 `last_acked_seq+1` 继续
- sandbox 恢复时（freeze/thaw）：同样从 `last_acked_seq+1` 续传，**绝不重发已 ack 的事件**
- control plane 重启：DB 是事实源，sandbox forwarder 自然重传未 ack 的部分

### Redis 定位

| 角色 | 存储 |
|---|---|
| 事实源 | Postgres |
| Sandbox WAL | outbox.sqlite |
| 传输缓冲（可选） | Redis Stream（在 control plane 内部） |
| UI pub/sub（可选） | Redis Pub/Sub（在 control plane 内部） |

**绝不下发 Redis 凭证到 sandbox**。如果 sandbox 直接调 Redis：

```
sandbox → Redis Stream → ingest worker → Postgres
```

是企业安全**反模式**（凭证外泄面扩大）。正确路径：

```
sandbox → control plane ingest API → Postgres（事务）
                              ↓
                          Redis Stream（内部 worker 写）
                              ↓
                          UI WebSocket fanout
```

## 不做什么

- ❌ 不让 sandbox 写 Postgres
- ❌ 不让 sandbox 写 Redis
- ❌ 不做"sandbox 重启 = 重发全部事件"（用 acked offset 续传）
- ❌ 不做"sandbox 端 2PC"（没必要，local outbox 已经够）
- ❌ 不做"sandbox 端消息总线"（一个 run 一个 outbox，简化）

## 故障处理清单

| 故障 | 检测 | 恢复 |
|---|---|---|
| network 中断 | HTTP timeout | forwarder 重试，backoff |
| sandbox 进程被杀 | process gone | 重启 forwarder，从 last_acked_seq+1 续 |
| sandbox 整个 freeze | warm snapshot 保存 outbox.sqlite | thaw 后 forwarder 续传 |
| ingest API 5xx | HTTP status | forwarder 重试整批，幂等保证不重 |
| ingest API 4xx token 失效 | 401/403 | 申请新 token（control plane 自动续期） |
| DB 拒绝（约束冲突） | 5xx 含 detail | 写 DLQ 表 + alert |
| 顺序乱（极端） | seq gap in DB | resp.missing_seq 触发 sandbox 补传 |
| 重复 | event_id 重复 | ON CONFLICT DO NOTHING 兜底 |


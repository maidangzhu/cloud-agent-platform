# ADR-0007：Run 取消、超时、孤儿回收

- 状态：已采纳
- 日期：2026-06-28
- 依赖：ADR-0001, ADR-0002
- 关键词：cancel、timeout、stale run、sweep

## 背景

用户原话：

> "我们之前明明做了 llm 卡死的处理，为什么这个场景下第二轮 run 还是等了好久？点击 cancel 都没有用，感觉像直接卡死了"

根因分析（2026-06-26 session 03e28c0e 复盘）：

```
run 99dae945 事件流：
  1: workspace_provisioning
  2: workspace_ready
  3: agent_started
  4: llm_entry_started
  5: run_timeout       ← 11min 后被 sweep 标 timeout
```

`llm-fallback.ts:289` 的 `await resultPromise` 没有接 abort signal。LLM 上游 TCP 半死不活时，pi-ai 的 `result()` promise 永不 resolve，外层 await 死等，run 函数不返回，DB status 改不到 cancelled。

11 分钟后 sweep（stale > 30min 阈值，但这次卡了 11min 不知怎么被标了）兜底救了。

**结论**：光靠 cancel button + run-agent.ts 的 abort handler 救不了 LLM 层的 race。必须 **多层防护**。

## 决定

### 4 层防护

```
Layer 1: 用户 cancel button
  → 写 runs.status = "cancel_requested"
  → run-agent.ts: 每 500ms 查 DB，看到 cancel_requested 调 agent.abort()
  → 在 agent.abort() 之前 LL 层 race 已修（ADR-0007-补）

Layer 2: agent 内部 abort signal
  → llm-fallback.ts: Promise.race([resultPromise, abortPromise])
  → abort 触发立刻 resolve 占位 result，stream 结束
  → 写 event: run_cancelled

Layer 3: 单 run 超时（agent 层）
  → run-agent.ts: maxSteps (默认 30) / maxDurationMs (默认 30min)
  → 超时 → agent.abort() → 写 run_timeout

Layer 4: DB 层 sweep（兜底）
  → 后台 cron 每 5min 扫 stale run
  → stale > 30min 且 status ∉ terminal → 写 run_timeout
  → 永远保证 DB 有终态
```

### Run 状态机

```
                POST /runs
                    │
                    ▼
            ┌───────────────┐
            │   created     │
            └───────┬───────┘
                    │ sandbox ready
                    ▼
            ┌───────────────┐
            │provisioning_  │
            │  workspace    │
            └───────┬───────┘
                    │ workspace ready
                    ▼
            ┌───────────────┐  Layer 1: cancel
            │   running     │ ←──── user cancel
            │               │       → cancel_requested
            │               │       → agent.abort()
            │               │       → cancel handler
            │               │
            └───┬───────┬───┘
                │       │
        success │       │ agent.abort()
                ▼       ▼
        ┌────────┐  ┌────────────────┐
        │completed│  │cancel_requested│
        └────────┘  └────────┬───────┘
                             │ agent ends
                             ▼
                       ┌───────────┐
                       │ cancelled │
                       └───────────┘

  Layer 3: agent 内 maxSteps/duration 触发
  Layer 4: stale > 30min sweep 触发
            → 直接 timeout
```

### Terminal 状态

```typescript
// 终态集合
export const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "timeout",
  "cancelled",
  "interrupted",
]);

// 状态机合法转移
const transitions = {
  created: ["provisioning_workspace", "cancel_requested", "failed"],
  provisioning_workspace: ["running", "failed", "timeout", "cancel_requested"],
  running: ["completed", "failed", "timeout", "cancel_requested", "interrupted"],
  cancel_requested: ["cancelled", "completed", "failed", "interrupted"],
  // 终态无出边
  completed: [],
  failed: [],
  timeout: [],
  cancelled: [],
  interrupted: [],
};
```

`canTransitionRun(from, to)` 工具函数做严格校验。

### Stale Sweep（Layer 4）

```python
# cron 每 5min
def sweep_stale_runs():
    threshold = now() - 30min
    candidates = SELECT * FROM runs
                 WHERE status IN ('created', 'provisioning_workspace', 'running', 'cancel_requested')
                 AND (last_heartbeat_at < threshold OR
                      (last_heartbeat_at IS NULL AND created_at < threshold))

    for run in candidates:
        # 双重检查：再看一次 last_heartbeat（避免 TOCTOU）
        recheck = SELECT last_heartbeat_at, status FROM runs WHERE id=?
        if recheck.status in TERMINAL_STATUSES:
            continue
        if recheck.last_heartbeat_at and recheck.last_heartbeat_at >= threshold:
            continue   # 心跳刚更新，跳过

        # 原子写
        with db.transaction():
            r = UPDATE runs
                SET status='timeout', completed_at=now()
                WHERE id=? AND status NOT IN TERMINAL_STATUSES
            if r.rowcount == 1:
                INSERT INTO agent_events
                  (id, run_id, type, payload, created_at)
                  VALUES (?, ?, 'run_timeout', '{"reason": "sweep: stale heartbeat"}', now())
```

**原子性**：UPDATE + INSERT 在同一事务，且 UPDATE 带 `WHERE status NOT IN TERMINAL_STATUSES` 防 race。

### Layer 2 细节（llm-fallback race fix，2026-06-28 已落地）

```typescript
// llm-fallback.ts
const resultPromise = innerStream.result();

// 把 abort signal 折成 promise
let abortResolve;
const abortPromise = new Promise<AssistantMessage>((resolve) => {
  abortResolve = resolve;
});
signal?.addEventListener("abort", () => {
  abortResolve?.(errorAssistantMessage(lastUsedEntry?.model, signal.reason));
});

// race 兜底
const result: AssistantMessage = await Promise.race([
  resultPromise,
  abortPromise,
]);
```

**回归测试**（`llm-fallback.test.ts` 末尾）：

```typescript
it("LLM 上游永不返回首 token → abort 后 stream.result() 在 1s 内 resolve", async () => {
  // 构造永不 emit 永不 resolve 的 stream
  // 100ms 后 abort
  // 验证 elapsed < 1s + result.stopReason === "error"
});
```

### Heartbeat

```python
# run-agent.ts 启动后
async def heartbeat_loop(run_id, abort_signal):
    while not abort_signal.is_set():
        UPDATE runs SET last_heartbeat_at=now() WHERE id=?
        await sleep(5s)

# 任何 LLM 工具调用 / tool call 完成后也更新
```

`last_heartbeat_at` 是 sweep 的关键指标。**5s 间隔** = 最坏情况 stale 5s + sweep 周期 5min = 5.5min 内被标 timeout。

### 用户感知

| 场景 | 之前 | 现在 |
|---|---|---|
| LLM 正常返回 + 用户点 cancel | 几秒内 cancel | 几秒内 cancel |
| LLM 卡死（TCP 半死不活） + 用户点 cancel | 11min 后 sweep 救，用户点 cancel 无效 | < 1s 内 cancel（Layer 2 race） |
| LLM 卡死 + 用户没点 cancel | 11min+ | Layer 3 max duration (30min) 或 Layer 4 sweep 兜底 |
| 单 run 工具循环 | 无 | maxSteps (默认 30) |

### 配置项

```bash
LLM_MAX_RUN_DURATION_MS=1800000     # 30min
LLM_HEARTBEAT_INTERVAL_MS=5000      # 5s
LLM_STALE_SWEEP_THRESHOLD_MS=1800000  # 30min
LLM_STALE_SWEEP_INTERVAL_MS=300000   # 5min
LLM_MAX_STEPS=30
```

env 覆盖，方便 P1 调优。

## 不做什么

- ❌ 不做"hard kill"（agent 进程被强杀会丢本地 outbox 写一半，违反 ADR-0002 原子性）。最多 SIGTERM + 5s 后 SIGKILL
- ❌ 不做"sandbox 死自动重启"（那是 ADR-0003 freeze/thaw 范畴）
- ❌ 不让用户改 stale 阈值（避免绕过监控）


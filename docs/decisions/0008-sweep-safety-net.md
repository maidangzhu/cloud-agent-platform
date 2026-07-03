# ADR-0008：Sweep 兜底 —— 绝不允许 run 永久停留在 running

**状态：** 已接受（2026-07-02）

## 决策

- 系统级不变量：**没有任何一个 run 允许永久停留在 `running`（或任何非终态）。**
- 由一个**定时触发的 sweep** 强制收敛：扫描 heartbeat 过期的非终态 run，按策略标记 `interrupted` / `timeout` / `cancelled`。
- **触发源（Vercel）：** Vercel Cron 定期打 `/api/sweep` 端点。最坏收敛延迟 = cron 间隔（如每分钟一次则最坏 ~1 分钟）。

## 背景

v1 痛点："SSE 不说停，run 也不进终态，永久挂着。"根因：run 的存活不能靠 runner "good citizen 地上报终态"——它 OOM/崩溃/断网时根本没机会上报。必须有外部裁判定期判死。

有了 sweep，最坏情况是"卡 ~1 分钟后自动变 interrupted，前端明确显示执行中断"，而非"永远转圈、不知死活"。这直接治好"跑着跑着没反应"的病，也是 [ADR-0001](./0001-execution-model.md) 发射后不管模型的必要兜底（Control Plane 对 run 内部盲，只能靠 heartbeat 推断）。

## 收敛策略

```
running + heartbeat 过期        -> interrupted 或 timeout
provisioning_sandbox + 过期     -> timeout
cancel_requested + 过期         -> cancelled 或 timeout（按策略）
```

## 测试守护

fake runner 发几个事件后 `process.exit(1)` 直接死、不发终态；断言 sweep 跑过后该 run 变 `interrupted`、SSE 发 `done`。对应 testing-strategy「stale fake runner swept」。

## 被否方案

- **只靠 runner 上报终态：** runner 崩溃时无法上报，导致永久 running。这正是 v1 的 bug。

## 连锁影响

- 依赖 [ADR-0007](./0007-stuck-diagnosis-model.md) 的 heartbeat 新鲜度判定。
- 与 state-machines.md 的 Sweep job 转移、agent-runtime-protocol §11 一致。
- human-in-the-loop 的 `waiting_for_input` 状态必须被 sweep 跳过或用超长超时（见 OPEN-QUESTIONS DQ-1）。

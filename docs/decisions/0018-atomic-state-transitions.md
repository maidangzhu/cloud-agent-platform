# ADR-0018：状态变更统一走条件原子 UPDATE，禁止 check-then-act

**状态：** 已接受（2026-07-03）

## 决策

系统内所有"先查询当前状态、再基于查到的状态决定是否执行变更"的操作（check-then-act），统一改为**一条数据库语句同时表达"检查条件"和"执行变更"**，用受影响行数（affected row count）判断这次转移是否生效，不允许应用层写"先 SELECT 再 UPDATE"两步式逻辑。

标准形态：

```sql
UPDATE "Run" SET status = $toStatus, updated_at = now()
WHERE id = $runId AND status = ANY($fromStatuses)
-- rowCount = 0 → 条件不满足（状态已被别的调用改走），本次是 no-op，不报错、不重试
-- rowCount = 1 → 转移生效
```

不允许的反模式：

```ts
// ❌ 两次独立往返之间留出竞态窗口
const run = await db.run.findUnique({ where: { id: runId } });
if (run.status === "running") {
  await db.run.update({ where: { id: runId }, data: { status: "interrupted" } });
}
```

## 覆盖的三处具体场景

### 1. Run.status 转移

所有 `RunStatus` 转移（见 [state-machines.md](../state-machines.md) §1）必须经过唯一入口函数 `transitionRun(runId, toStatus, fromStatuses[])`，内部实现即上面的条件 UPDATE。不允许任何调用点（sweep job、cancel 端点、ingest 终态事件处理、runner 上报 completed/failed）绕过这个函数自己写状态判断。

这直接解决 memory 记录的具体竞态：sweep 判定某 run heartbeat 过期准备标记 `interrupted` 的同一时刻，sandbox 可能正好上报 `completed`——谁的 UPDATE 先落地，`fromStatuses` 条件就会让后到的那次 UPDATE 影响 0 行，不会出现"终态被覆盖"。

### 2. Workspace 归档检查 + 创建 Run 的 TOCTOU

"检查 workspace 是否 active"和"创建 Run"不能是两次独立请求之间留窗口的操作。改用 insert-select：

```sql
INSERT INTO "Run" (id, workspace_id, thread_id, user_id, prompt, status, ...)
SELECT $1, w.id, $2, $3, $4, 'created', ...
FROM "Workspace" w
WHERE w.id = $5 AND w.status = 'active'
-- 插入 0 行 → workspace 在检查和插入之间被归档，返回 409 CONFLICT
```

同一模式适用于 Thread 归档检查（`archived thread 不能启动新 run`）。

### 3. SandboxInstance warm/ready 复用互斥

两个并发的 "getOrCreate sandbox" 请求不能都拿到同一个可复用实例。给 `SandboxInstance` 新增字段 `currentRunId String?`（见 [data-model.md](../data-model.md) §3.13 修订），认领动作：

```sql
UPDATE "SandboxInstance" SET status = 'ready', current_run_id = $runId, updated_at = now()
WHERE workspace_id = $1 AND status IN ('warm', 'ready') AND current_run_id IS NULL
RETURNING id
-- 0 行 → 没抢到，本次请求走"创建新沙箱"分支，不重试等待、不排队
```

`currentRunId` 同时是可观测性收益——排查"卡死"问题时能直接看到某个沙箱当前被哪个 run 占用。Run 进入终态或 `waiting_for_input`（见 [ADR-0019](./0019-waiting-for-input-state.md)）时，必须原子地把对应 SandboxInstance 的 `currentRunId` 清空（同一个 `transitionRun` 收尾逻辑里做，不是独立的第二次写入）。

## 背景

拷问阶段三路 Explore 扫描发现同一个 check-then-act 模式在三层重复出现，但只有 revision 递增（[ADR-0015](./0015-usage-telemetry-and-ops-priorities.md) §2）被明确要求走原子操作，其余三处停留在"文档没写清楚具体怎么做"的状态。这条 ADR 把该原则从"revision 专属"提升为"全系统状态变更的统一约束"，并且要求在接口设计阶段（当前阶段）就定下来，不允许留到写实现代码时才发现竞态。

## 被否方案

- **应用层加锁（如 Redis 分布式锁）**：Postgres 原子 UPDATE 本身就是数据库标准能力，不需要额外的锁基础设施；引入分布式锁反而增加一个新的失败模式（锁没释放、锁服务不可用）。
- **乐观锁版本号（`WHERE version = $expectedVersion`）**：对 revision 递增这类"只关心拿到下一个号"的场景是不必要的间接层；对状态转移场景，`WHERE status = ANY(...)` 本身就是等价的、更直观的条件表达，不需要额外维护一个 version 字段。

## 连锁影响

- Run Service（[backend-domain-model.md](../backend-domain-model.md) §4）的"transition status"操作必须统一实现为 `transitionRun`，不允许分散实现。
- `state-machines.md` §1 的"必测单元用例"需要补充：并发调用 `transitionRun` 时，只有一次生效，另一次影响 0 行且不报错。
- `data-model.md` §3.13 `SandboxInstance` 需要新增 `currentRunId` 字段和对应索引。
- 这一批测试属于 route/integration 层（需要真实数据库验证并发原子性，无法用 unit test 完全覆盖），要在 testing-strategy.md 的 Run/Sandbox 测试矩阵里补充"并发竞态"类用例。

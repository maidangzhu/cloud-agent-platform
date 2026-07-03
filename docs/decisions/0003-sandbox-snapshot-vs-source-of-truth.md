# ADR-0003：沙箱用快照加速复用；Control Plane 仍是文件/artifact 事实源

**状态：** 已接受（2026-07-02）

## 决策

- 沙箱复用/加速使用 **Vercel Sandbox 的快照/持久化机制**（已 GA、默认开启，停止时自动存盘、恢复时自动还原文件系统）。P0 **不**手写 eager 水合。
- Control Plane（Postgres + 对象存储）**仍是**用户可见文件（WorkspaceFile）与 Artifact 的**事实源**。
- **`write_file → ingest` 写回链不可省**：无论有没有快照，agent 写文件都必须立刻 ingest 回 DB。

## 背景

快照恢复的是"整个磁盘"，水合恢复的是"业务事实源"，两者恢复的东西不同，不是二选一。快照必要但不充分：

1. **快照会过期、会丢，不是事实源。** 用户资产的最终归属必须在自己的 DB + 对象存储，不能取决于 provider 快照保留策略。
2. **快照是黑盒磁盘，UI 读不了。** 前端文件面板查 DB（`GET /api/workspaces/:id/files`），不去沙箱 `cat`。文件只活在快照里 = UI 看不见、artifact 无法恢复。
3. **快照是全盘，DB 是精选。** 快照含 `node_modules`、`git clone` 出的上万临时文件（这正是它加速的用途）；这些不该、也不能变成用户可见的 WorkspaceFile。

## 三层文件模型

| 层 | 谁产生 | 持久？ | 用户可见？ |
|----|--------|--------|-----------|
| 沙箱临时文件 | `run_command` 顺手产生 | 沙箱回收即没（快照可留作加速） | ❌ |
| WorkspaceFile | 经 `write_file`/ingest 显式登记 | ✅ 在 DB/对象存储 | 文件面板可见 |
| Artifact | 经 `create_artifact` 提升 | ✅ 快照可恢复 | 一等交付物 |

## 机制分工

| 机制 | 恢复什么 | 归谁 | 作用 |
|------|---------|------|------|
| 快照 / persistence | 整个磁盘（依赖、临时文件、工作副本） | Vercel provider | 加速：新 run 不用重装环境/重 clone |
| ingest → DB/对象存储 | 用户可见 WorkspaceFile + Artifact | 本项目（事实源） | 真相 + UI 可读 + 永久归属 |

大方向一句话：**持久的家在 Control Plane，沙箱只是 agent 的工作副本（working copy），DB 是事实源，沙箱文件系统是易失缓存。**

## 被否方案

- **启动即全量水合（eager hydration）：** Vercel 快照又快又现成，自己灌文件是重复造轮子。P0 否。
- **懒加载（用时再从 CP 拉）：** 当前规模不需要，实现更绕。否。
- **只靠快照、不落 DB：** UI 读不到、资产归属不可靠。否。

## 连锁影响

- 修正 [ADR-0001](./0001-execution-model.md) 中"warm 复用"语义：复用的是快照恢复的磁盘状态，不是常驻实例。
- `SandboxInstance` 表需记 `snapshotId` / 恢复相关字段（data-model 已有 `snapshotId`、`snapshotExpiresAt`）。
- 依赖 Vercel 快照能力，属外部依赖，需在集成测试中验证。

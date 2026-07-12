# ADR-0014：Run 启动前的文件水合机制——版本号水位线 + 增量 diff

**状态：** 已接受（2026-07-03）

## 决策

UI/API 对 WorkspaceFile 的修改（在没有活跃 run 时发生）如何让下一次 run 的沙箱感知到，采用**版本号水位线 diff**，不做持续推送、不引入文件系统同步 daemon、不用 git 做 diff 引擎。

核心机制：

1. `WorkspaceFile` 表新增 `revision: bigint`，每次内容变化（无论来自 agent `write_file` 还是 UI 编辑）从 workspace 级自增序列取号递增。
2. `SandboxInstance` 表新增 nullable `syncedUpToRevision: bigint` 和 `pendingSyncRevision: bigint`。`NULL` 明确表示从未同步或 provider fresh recreate；pending target 只由 Control Plane 写入。
3. 新 run 启动、沙箱点火**之前**，Control Plane 执行：
   ```sql
   SELECT * FROM WorkspaceFile
   WHERE workspaceId = :workspaceId
     AND revision > :syncedUpToRevision
   ```
4. 查询结果（增量文件集合，可能是 0 条、1 条或上百条，处理逻辑一致）打包进 runner 启动配置新增字段 `filesToSync`，随 [agent-runtime-protocol.md](../agent-runtime-protocol.md) 第 4 节的启动 JSON 一并下发。
5. Runner 在 boot 阶段（协议第 5.1 节）第一件事：遍历 `filesToSync`，逐条覆盖写入 `workspaceRoot`，再进入 `agent_loop`。Runner 不做任何"新旧判断"，纯执行覆盖指令。
6. Control Plane 在 runner 启动前 stage `pendingSyncRevision`。只有 `run_completed` ingest side effect 可以在释放 sandbox 前把 pending target 推进为 `syncedUpToRevision`；失败、取消和 timeout 只清 pending，保留旧 watermark 以便下次安全重放。

删除处理：`WorkspaceFile` 不做物理删除（否则 revision 机制查不到"这行曾变化过"），改为软删除标记（如 `isDeleted: true` + 递增 revision）。`filesToSync` 数组里对应项带 `isDeleted: true`，runner 收到后删除沙箱磁盘上的对应文件。

冷启动 / 从未同步过：`syncedUpToRevision=NULL`，diff 查询返回全部 WorkspaceFile（包括 legacy revision 0 行），完成后可以推进到 workspace 当前 revision。

Vercel named sandbox 的 `onCreate` 是快照是否真正恢复的判据。若 persistent sandbox 被删除、快照过期或 provider 以同名 fresh create，Control Plane 必须清空 watermark。当前 SDK 对已删除 named sandbox 可能直接返回 404，因此 factory 显式 fallback 到 named `Sandbox.create`，并同样标记 fresh。

P0 只水合 inline text、directory 和 delete tombstone。只有 `storageKey`、没有 inline content 的文件会让 provisioning 明确失败；在对象存储下载链路落地前，不允许静默跳过后启动不完整 workspace。

沙箱离线时长（几分钟或几天）不影响这个机制——`syncedUpToRevision` 安全存在 Postgres，不因沙箱关机/挂掉而丢失或过期，下次点火时无论离线多久，一次查询就能拿到期间全部增量。

## 背景

对照另一个真实产品（代号 Moxt，agent-in-sandbox + workspace 架构）的做法：其"下行同步"（后端 → 沙箱）触发点绑定在"用户发送下一条消息"这一事件上，用一个常驻同步进程（mfs）+ 本地 git commit 实现，每次触发是**全量**重写文件并打一次 git 快照，git 在其架构里**不参与同步**，只作为免费的本地变更审计日志，供"查历史"类功能读取。

两点差异，解释了为什么本项目不照抄：

1. **领域模型不同。** Moxt 的 workspace 是一棵通用文件树（任意结构、任意数量文件），只能用通用文件同步工具 + git 当 diff 引擎。本项目的 WorkspaceFile 是类型化的数据库行，天然带结构化的版本信息，不需要一个外部工具去"发现"哪些变了——数据库一条 `revision >` 查询就是精确答案，比 git diff 两段文本更精确（知道的是"这一行从版本 2 变成版本 3"，不是"这段文本和那段文本有什么区别"）。
2. **触发粒度可以更细。** Moxt 绑定"发消息"事件做全量 sync；本项目绑定"run 启动前"做增量 diff，效果类似（都是离散边界点同步，不做活跃执行期间的持续推送），但增量粒度避免了不必要的全量重写。

## 被否方案

- **通用文件同步 daemon（照抄 mfs）：** 本项目的文件集合是类型化、可查询的数据库表，不是无结构文件树，引入通用同步机制是不必要的复杂度。
- **git 作为 diff 引擎：** 数据库的 `revision` 字段已经精确回答"谁变了、变成第几版"，不需要 git 历史或 `git diff` 辅助判断新旧。
- **用 `updatedAt` 时间戳判断新旧：** 批量修改场景下多条更新可能落在同一时刻，或应用服务器/数据库时钟存在偏差，时间戳比较不可靠。改用 workspace 级单调递增整数序列，与 [ADR-0006](./0006-event-seq-at-source.md)"事件 seq 由源头分配，消费者按 (runId, seq) 幂等"是同一设计思路。
- **持续推送通道（Control Plane 主动往活跃沙箱推变更）：** 纯 Vercel 环境缺乏支撑长连接的载体（见 [OPEN-QUESTIONS DQ-2](./OPEN-QUESTIONS.md)），且这个成本不该为一个低频、非核心的编辑场景支付。

## 未覆盖的相邻问题（不在本 ADR 范围内，待续）

- **活跃 run 执行期间，UI 编辑文件是否生效：** 本 ADR 只解决"run 启动前"的水合，不解决"run 正在跑的几十分钟内"外部编辑如何让沙箱感知——这个场景倾向于不做实时同步，UI 层面在 active run 期间锁定文件编辑入口（与 [design-system.md](../design-system.md) 9.3 "active run 时 composer 禁用" 同一思路），但尚未正式拍板落盘。
- **Agent 通过非 `write_file` 手段产生的文件（如 `run_command` 跑脚本/`git clone` 生成的中间产物）不会被自动 ingest：** 该边界已按 ADR-0003 固定为临时 working-copy 文件，不做 finalize 全盘扫描。需要持久化的产出必须显式走 `write_file`；workflow gate 已验证 `run_command` 产生的文件不会变成 WorkspaceFile。

## 连锁影响

- **data-model.md**：`WorkspaceFile` 新增 `revision`；`SandboxInstance` 新增 `syncedUpToRevision`。
- **agent-runtime-protocol.md**：第 4 节启动配置 JSON 新增 `filesToSync` 字段；第 5.1 节 boot 阶段新增"写入 `filesToSync`"步骤。
- **api-contract.md**：涉及 WorkspaceFile 更新的端点（UI 编辑触发的 PATCH）需要在写入时递增 `revision`。

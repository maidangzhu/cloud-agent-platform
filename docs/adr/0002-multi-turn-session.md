# ADR-0002：会话模型 —— 多轮会话（Session + Message）

- 状态：已采纳
- 日期：2026-06
- 相关：[ADR-0001](./0001-sandbox-as-tool.md)、[`data-model.md`](../data-model.md)、[`prd.md`](../prd.md)

## 背景

平台要让用户提交自然语言任务、由 agent 在隔离环境执行并返回结果。「用户与平台的交互模型」有两种取向，决定数据模型与 workspace 生命周期：

### 范式 A：单任务模型

提交 prompt → agent 跑完 → 出报告，不支持追问。一个 `Run` = 一次任务 = 一次会话。无 `Session` / `Message` 表，执行过程全部记录在 `AgentEvent`。贴合题目例子「读仓库、找 TODO、生成报告」，工期最小。

### 范式 B：多轮会话模型

像 Claude Code / Devin 那样可连续对话：用户追问，agent 接着上次的 workspace 继续干。引入 `Session`（会话容器）+ `Message`（对话消息）两张表，`Run` 成为 `Session` 下的一次执行，workspace 跨 Run、跨沙箱实例复用。

## 决策

**采用范式 B（多轮会话模型）。**

数据模型为 7 张表：`Session` / `Workspace` / `Message` / `Run` / `AgentEvent` / `ToolCall` / `Artifact`（详见 [`data-model.md`](../data-model.md)）。

## 理由

1. **更贴合题目类比**。题目明确类比 Claude Code Cloud / Devin / OpenAI agent 平台——这些都是可多轮交互的产品。多轮会话更能体现「平台」而非「一次性脚本」。

2. **展示更完整的状态分层**。`Session`（会话）/ `Message`（对话）/ `Run`（执行）/ `AgentEvent`（执行细节）四层分明，正面呼应考点「整体架构与可扩展性」。

3. **两层 message 的区分是设计亮点**：
   - `Message` = 用户视角的对话（user 一条、assistant 一条）。
   - `AgentEvent` = 某条 assistant 消息背后那次 Run 的执行流水（模型步、工具调用、结果）。
   - 一次典型 Run：1 条 user `Message` → N 条 `AgentEvent` → 1 条 assistant `Message` + `Artifact`。

## 连带决策：workspace 会话内持久（跨请求、跨沙箱实例）

多轮会话下 workspace 必须跨请求、跨沙箱实例存活（serverless 下每次请求是独立 Function 实例，本地临时目录不保留）。采用分层策略，详见 [ADR 关联的 `sandbox-research.md` 第 6 节]：

- **① 文件延续（P0 必做）**：persistent 命名沙箱，`getOrCreate({name})` 活着复用、回收则重建。
- **② 快照恢复（P0 增强）**：停止前 `snapshot()`，重新进入从 `snapshotId` resume。
- **③ 自动 hibernate 编排（P1，不做）**：定时判断空闲→休眠→lease，是 Open Agents lifecycle workflow 那套复杂度。

「过几天回来继续对话」的恢复路径：对话历史读 DB（永久）+ workspace 从 snapshot resume（一次冷启动）。边界：snapshot 存文件不存运行进程。

## 取舍 / 后果

- **工期**：相对单任务模型约 +60~80% 代码量（+2 张表、+会话/消息 API、workspace 从「每次新建」改「getOrCreate 复用」、UI 从单次结果页改对话流）。通过渐进交付控制风险：先 ①（文件延续）跑通多轮，再 ②（snapshot/resume）做会话恢复，任何时刻有可交付版本。
- **TDD 折扣**：snapshot/resume 真实验证只能在阶段 6 真接 Vercel 时做；前面阶段用 LocalSandbox 目录复用 + tar 近似，测不到真快照恢复。
- **与 ADR-0001 的关系**：仍是 Sandbox as Tool —— agent loop 在 server，多轮只是多次触发 loop 并复用同一沙箱后端，未改变 agent 与 sandbox 的边界。
- **明确不做（P1）**：自动 hibernate 生命周期编排、多份历史快照、多用户隔离（User/Project）。

## 结论

P0 采用多轮会话模型：`Session` 为会话容器，用户可在会话内追问，`Message` 持久化对话，`Run` 是一次执行，workspace 经命名沙箱复用 + snapshot/resume 会话内持久（做 ①②，不做 ③）。

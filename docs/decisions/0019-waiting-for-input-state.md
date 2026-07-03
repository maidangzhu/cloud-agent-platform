# ADR-0019：新增 `waiting_for_input` 状态并下沉到协议全链路；解决 DQ-1

**状态：** 已接受（2026-07-03）

## 决策

解决 [OPEN-QUESTIONS DQ-1](./OPEN-QUESTIONS.md)：新增 `RunStatus.waiting_for_input`（非终态、非活跃执行的第三类"合理挂起"），并在状态机、SSE 协议、composer UI 规则三处同时落地——这三处任何一处遗漏都会导致 [ADR-0013](./0013-mechanism-deep-dive-refinement.md) 的 Stage1→Stage2 主交互路径被堵死。

### 1. 状态机（修订 [state-machines.md](../state-machines.md) §1）

新增转移：

```text
running -> waiting_for_input        （触发者：Sandbox Runner 通过 ingest 上报，非终态）
waiting_for_input -> cancel_requested
waiting_for_input -> completed      （见下方"不做 resume"）
waiting_for_input -> interrupted    （sweep，超过阈值无人回应）
```

**关键简化：不做"resume 同一个 run"。** Sandbox 上报"我要停下来问问题"的那一刻，sandbox runner 进程正常退出（走 finalize 流程，不是 crash）。这个 run 随即被标记为 `waiting_for_input`——它已经完成了自己的产出（Stage 1 概览 artifact），只是"完成"的同时带着一个待选问题，不需要保持进程存活等待恢复。

用户在 UI 给出的选择，不走专门的"回答"端点，而是**直接复用 `POST /api/threads/:threadId/runs`** 发一条新消息。Control Plane 收到时：

1. 检测该 thread 是否存在一个 `waiting_for_input` 的 run。
2. 如果存在，先用 [ADR-0018](./0018-atomic-state-transitions.md) 的 `transitionRun` 把它原子转为 `completed`。
3. 再创建新 run（Stage 2 深挖），新 run 的 prompt 包含用户选择的机制。

这与 ADR-0013 的产品模型完全对齐：Stage1/Stage2 是同一个 thread 内的两个独立 run，通过 thread 衔接，不是"暂停又恢复同一进程"。

沙箱侧：进入 `waiting_for_input` 时，对应 `SandboxInstance` 转 `warm`（[ADR-0018](./0018-atomic-state-transitions.md) 收尾逻辑清空 `currentRunId`），不继续占用计费；Stage 2 的新 run 走已有的 warm 复用逻辑（[ADR-0003](./0003-sandbox-snapshot-vs-source-of-truth.md)），不需要额外设计。

sweep 阈值：`waiting_for_input` 超过 **7 天**无人回应，由 sweep 转 `interrupted`（这是一个默认值，不是拍死的数字，可在实现阶段按实际使用节奏调整；7 天的取值逻辑是"低频、事件驱动型使用"——[ADR-0013](./0013-mechanism-deep-dive-refinement.md) 背景里已经确认这个产品不追求高频留存，用户可能过几天才回来继续深挖）。

### 2. DerivedUiState（修订 state-machines.md §2）

新增 `waiting_for_input`，直接映射自身（不需要 heartbeat 推导，因为这个状态本身就代表"agent 已经停止工作，在等人"）：

```text
RunStatus.waiting_for_input -> DerivedUiState.waiting_for_input
```

### 3. SSE 事件类型（修订 [agent-runtime-protocol.md](../agent-runtime-protocol.md) §7）

新增事件 `run_waiting_for_input`，payload 定义见 [ADR-0020](./0020-agent-event-payload-schema.md)：

```ts
{ question: string; options?: string[] }
```

### 4. Composer 规则（修订 design-system.md §9.3）

原规则"有 active run 时禁用 submit"是错误的——它会堵死 Stage1→Stage2 的唯一用户入口（回答问题的唯一现实途径就是 composer 提交）。改为按 `derivedUiState` 精确区分：

```text
idle / running / possibly_running / cancelling
  → 禁用 submit（agent 在干活或收尾中）

waiting_for_input
  → 启用 submit（这正是用户的回答入口）
  → placeholder 换成引导性文案（如"回答 agent 的问题…"）
  → composer 上方显示提示条，展示 run_waiting_for_input 事件里的 question/options

completed / failed / timeout / cancelled / interrupted
  → 启用 submit（run 已结束，用户可以开始新一轮）
```

判断逻辑必须写成一个共享 hook `useComposerEnabled(run: RunDTO)`，桌面端和移动端共用同一份条件判断——之前"移动端 waiting_for_input 零设计"的根因就是判断逻辑很可能在两端各写一份，容易出现同款遗漏。移动端本身不需要额外布局设计，只要接入这个共享 hook。

## 背景

[ADR-0013](./0013-mechanism-deep-dive-refinement.md) 把产品叙事收窄为"两阶段交互"后，"agent 出概览后停下等用户选择"从边缘 human-in-the-loop case 变成**每次调研都会走到**的主路径地基。三路 Explore 扫描发现这个状态在协议层完全没有落地：state-machines.md 没有这个状态，SSE 事件列表没有对应事件，composer 规则的现有措辞会直接堵死这条路径。这条 ADR 把 [OPEN-QUESTIONS DQ-1](./OPEN-QUESTIONS.md) 正式解决并下沉到三处具体文档。

## 被否方案

- **反向通道恢复同一个 sandbox 进程**：需要设计"暂停信号怎么传给 sandbox"、"sandbox 怎么在等待期间不被 sweep 误杀又不无限占用计费"、"用户答案怎么注入回一个休眠的 agent loop"——三个新问题，每个都比"直接开一个新 run"更复杂，且和 [ADR-0001](./0001-execution-model.md) 发射后不管模型的精神相悖。
- **专门开一个"回答问题"端点（如 `POST /api/runs/:runId/answer`）**：会让 Stage 2 的输入入口和普通对话输入入口是两个不同的 API，前端要维护两套提交逻辑；复用 `POST /api/threads/:threadId/runs` 让"发消息"永远只有一条路径。

## 连锁影响

- `state-machines.md` §1/§2：新增状态、转移表、DerivedUiState 映射、必测用例（"running 可以转 waiting_for_input"、"waiting_for_input 不会被 sweep 在 7 天内误杀"、"waiting_for_input 之后创建新 run 会先把旧 run 转 completed"）。
- `agent-runtime-protocol.md` §7：新增 `run_waiting_for_input` 事件类型；§5.4 Finalize 一节需要说明"上报 waiting_for_input 也是一种合法的 finalize 路径，不是异常退出"。
- `data-model.md` §4 `RunStatus` 枚举新增 `waiting_for_input`。
- `design-system.md` §9.3 Composer 规则整段重写（见上）。
- `api-contract.md` `RunDTO.status`/`derivedUiState` 枚举新增该值；`POST /api/threads/:threadId/runs` 的规则新增"如果 thread 有 waiting_for_input 的 run，先原子转为 completed"。
- `docs/decisions/OPEN-QUESTIONS.md`：DQ-1 移除，标记为已解决并链接本 ADR。

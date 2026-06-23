# ADR-0003：执行事件存储与前端渲染策略

- 状态：已采纳
- 日期：2026-06
- 相关：[ADR-0002](./0002-multi-turn-session.md)、[`data-model.md`](../data-model.md)、[`api-contract.md`](../api-contract.md)

## 背景

Agent 执行一次 Run 时，会产生两类截然不同的数据：

1. **对话数据**：用户的 prompt 和 agent 的最终回复，属于会话层，需要跨 Run 持久留存，喂给下一轮 LLM 作为历史上下文。
2. **执行过程数据**：模型推理步骤、工具调用（含参数与结果）、workspace 事件等，属于单次 Run 的操作日志，数量远超对话数据（一次 Run 通常产生 10-50 个事件，而对话只有 2 条消息）。

问题核心：**执行过程数据存在哪、前端如何消费？**

### 参考方案：Vercel open-agents 的做法

open-agents 使用 Vercel AI SDK 的 `UIMessage` 格式，将工具调用内嵌在 assistant message 的 `parts` 数组中：

```ts
message.parts = [
  { type: "text",       text: "我来查一下..." },
  { type: "tool-bash",  input: { command: "npx maidang whoami --json" }, output: {...} },
  { type: "tool-write", input: { path: "notes/songs.md", content: "..." }, output: {...} },
  { type: "text",       text: "已经写好了，文件包含..." },
]
```

前端直接读 `message.parts` 渲染，工具调用收起为 `"Pondering · 3 tool calls"` 摘要栏，点开展开详情。

这对 demo 级产品够用，但把所有执行数据塞进 `messages` 单表存在生产隐患。

## 决策

**执行事件与对话消息分离存储，前端通过 SSE 事件流重建渲染结构。**

### 存储层

| 表 | 存什么 | 规模估算 |
|---|---|---|
| `Message` | 用户 prompt + agent 最终回复（纯文本） | 每次 Run 2 条 |
| `AgentEvent` | append-only 执行事件流（run_created / model_step / tool_call_started / tool_call_completed / ...） | 每次 Run 10-50 条 |
| `ToolCall` | 工具调用的 args / result / status（结构化） | 每次 Run 2-20 条 |
| `Artifact` | 最终报告、生成文件的引用 | 每次 Run 0-N 条 |

`Message` 表保持轻量，只存对话上下文所需的最小字段；执行细节在 `AgentEvent` + `ToolCall` 中单独管理。

### 前端渲染层

前端通过 `GET /api/runs/:id/events`（SSE）订阅执行事件流，将事件重建为可渲染的结构：

```
[用户气泡]        userPrompt                     ← from Message

[执行过程，可折叠] ▸ Pondering · 3 tool calls    ← 默认收起
    tool_call_started  → [工具卡片：命令/路径/参数]
    tool_call_completed→ [结果预览，展开查看全文]
    model_step         → [AI 中间推理文本]

[AI 回复气泡]     最终 assistant 回复             ← from Message
```

断线重连时，SSE 首条 `event: snapshot` 携带已落库的所有事件，前端可无缝补齐历史记录。

## 理由

**1. 生产规模可扩展**

生产环境每天数千次 Run，每次产生数十个事件。若将所有工具调用内嵌 `Message.parts`（JSON blob），单表行体积随工具调用数线性膨胀，且 `result` 字段可能包含大段代码输出（数 KB 至数十 KB）。分表后：
- `Message` 保持小而快，对话历史查询不受执行数据影响
- `ToolCall.result` 可独立做冷归档或迁至 blob storage，不影响热查询
- 执行事件可按 Run 生命周期做分区/归档

**2. 多维可查询**

`ToolCall` 表建有 `(name, status)` 索引，可直接做运营分析：
- 哪个工具失败率最高？
- 哪些 Session 的工具调用被 policy 拒绝最多？
- 今日 `run_command` 超时次数？

这些问题在 JSON blob 里无法高效回答。

**3. 前端体验不降级**

SSE 事件流 + `event: snapshot` 断线重连设计保证前端可实时展示执行过程，效果与 open-agents 的 parts 渲染一致——只是数据源从内嵌 parts 改为事件流重建，对用户无感知差异。

**4. 审计与可观测性**

`AgentEvent` append-only 设计是不可变的操作日志，天然适合审计（何时触发、触发了什么、结果如何）。内嵌 parts 在修改/更新时无法区分历史状态。

## 取舍

| 维度 | 分表方案（本项目） | 内嵌 parts（open-agents） |
|---|---|---|
| 实现复杂度 | 较高：前端需重建渲染结构 | 低：直接读 parts |
| 生产可扩展 | ✅ 分表可独立扩展/归档 | ❌ 单表膨胀，大 JSON blob |
| 可查询性 | ✅ 结构化字段可建索引 | ❌ JSON blob 不可高效查询 |
| 审计追踪 | ✅ append-only 不可变日志 | ❌ 状态可被覆盖 |
| 前端体验 | ✅ SSE 实时流，等价效果 | ✅ 简单直接 |
| 适用场景 | 生产级平台 | Demo / 原型 |

open-agents 的 parts 设计对其 demo 场景完全合理。本项目面向生产级平台场景，分表存储在规模化后的优势更显著。

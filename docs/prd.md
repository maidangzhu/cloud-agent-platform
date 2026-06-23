# 产品需求文档 (PRD) — Cloud Agent Platform

## 1. 背景与目标

构建一个 Cloud Agent Platform：用户提交一段自然语言任务，平台启动一个自主 agent，在云端隔离环境中调用 LLM 推理、调用工具（执行命令、读写文件）、循环迭代直至完成，最后返回结果。可类比 Claude Code Cloud / Devin / OpenAI 的 agent 运行平台。

四个考察重点：

- Agent 编排与调度
- 沙箱与隔离执行
- LLM 集成与工具调用
- 整体架构与可扩展性

**产品定位**：本期交付一个能跑通端到端主链路、**支持多轮对话**的 MVP，并用架构文档说明生产级演进路径。不追求做成完整的 Devin / Claude Code Cloud。

**核心场景**：

> 用户输入「读取这个仓库，找出所有 TODO，生成一份报告」，平台启动一个云端 agent，在隔离 workspace 中读取文件、搜索内容、必要时执行命令，最后返回结构化报告；用户可在同一会话内继续追问（如「按优先级排序并写入文件」），agent 复用同一 workspace 接着干，离开后再回来仍能继续。

## 2. 目标用户

| 用户 | 诉求 |
| --- | --- |
| 评审者 | 通过一个可运行项目，判断是否理解 Cloud Agent Platform 的核心边界 |
| Demo 使用者 | 输入自然语言任务，观察云端 agent 如何读仓库、调工具、生成结果 |
| 开发者本人 | 用最小实现证明 agent runtime、sandbox、事件持久化、UI 主链路 |

## 3. 真实目标（评审看三件事）

1. 能把自然语言任务拆成 agent 运行时、工具系统、沙箱、状态流和前后端体验。
2. 知道哪些是 MVP，哪些是生产级系统才需要的。
3. 能用代码跑通一条端到端链路，而不是只画大图。

> 核心主张：LLM 输出不能直接进入危险执行层，中间必须有工具协议、校验器、状态机、快照和可观测日志。模型是规划器，不是无边界执行器。

## 4. 核心对象

| 对象 | 含义 | 范围 |
| --- | --- | --- |
| `Invite` | 访问门禁，替代登录/计费 | P0 |
| `Session` | 长期会话容器，支持多轮对话 | P0 |
| `Workspace` | session 绑定的沙箱引用（命名沙箱 + snapshot，可复用/恢复） | P0 |
| `Message` | 用户 ↔ agent 的对话消息 | P0 |
| `Run` | 一次 agent 执行（一条 prompt → 一轮 loop） | P0 |
| `AgentEvent` | Run 内执行过程中的事件流 | P0 |
| `ToolCall` | 一次工具调用及结果 | P0 |
| `Artifact` | 最终报告或生成文件 | P0 |
| `User / Project` | 多用户、多项目 | P1 |
| `WorkspaceSnapshot / QueueJob` | 多份历史快照、后台调度 | P1 |

P0 关系：一个有效邀请码可创建多个 Session；一个 Session 绑定一个 Workspace、含多条 Message 和多个 Run；一个 Run 含多个 AgentEvent 与 ToolCall、产出零或多个 Artifact。详见 [`data-model.md`](./data-model.md)。

## 5. 状态流转

**Session 状态**：`active → archived`

**Run 状态**：

```text
created → provisioning_workspace → running → completed
分支：failed / timeout / cancel_requested → cancelled / interrupted
```

**ToolCall 状态**：

```text
pending → running → completed
                 → failed / timeout / rejected
```

**Workspace 状态**：

```text
pending → provisioning → ready → archived
                       → failed
（ready 后可被快照，下次会话从 snapshot resume 回到 ready）
```

## 6. 用户动作与约束

| 动作 | 入口 | 约束 |
| --- | --- | --- |
| 输入邀请码 | `/invite` | 服务端可信校验；前端缓存不算数，API 二次校验 |
| 创建会话 | `POST /api/sessions` | 必须有有效邀请码；建 Session + workspace（lazy） |
| 发送消息（追问） | `POST /api/sessions/:id/runs` | 在会话内追加 user message，触发一次 Run；复用同一 workspace |
| 查看事件流 | SSE / 轮询 | 实时看 model step、tool call、结果 |
| 查看报告 | 报告面板 | 展示 Markdown artifact |
| 取消 run | `POST /api/runs/:id/cancel` | best-effort，至少不再进入下一轮 model step |
| 继续历史会话 | `GET /api/sessions/:id` | 读对话历史 + 从 snapshot resume workspace，接着对话 |
| 刷新恢复 | `GET /api/runs/:id` | 从 DB 恢复事件与 artifact，判断 run 存活状态 |

**工具执行约束**：所有工具经 Tool Registry 与 schema 校验；文件路径限制在 workspace 内；命令执行有 timeout；stdout/stderr 截断；高风险命令默认拒绝；工具结果必须写入事件。

## 7. 副作用与关键原则

| 动作 | 副作用 |
| --- | --- |
| 创建会话 | 写 DB、（lazy）准备 workspace |
| 发送消息 | 建 Run、写 user Message、触发 agent loop |
| provision/resume workspace | 创建或从 snapshot 恢复 sandbox |
| agent model step | 消耗 token、产生 reasoning / tool call |
| tool call | 读写 workspace 文件、执行命令 |
| write artifact | 写 DB、写 workspace 文件、写 assistant Message、更新 UI |

> 关键原则：所有副作用都必须进入事件流，否则 UI、debug 和恢复都会断。上下文压缩可以有损，但平台事件流不能有损。

## 8. 范围划分（P0 / P1 / P2）

**P0（本期 MVP）做**：邀请码访问、**多轮会话**（Session + Message）、Vercel Function 内跑 agent loop、SSE 事件流、Postgres 持久化、本地/Vercel 沙箱、5 个最小工具、demo repo 找 TODO 生成报告、**workspace 会话内复用与 snapshot resume（①persistent 文件延续 + ②显式 snapshot/resume）**。

**P0 不做**：OAuth、真实多用户、计费、GitHub App、PR、**自动 hibernate 生命周期编排（③）**、durable workflow、独立 worker、subagent、向量记忆。

**P1（生产化）**：Queue + worker、run cancel/retry、自动 hibernate/resume 编排（③）、多份历史快照、git repo clone、diff view。触发条件：agent 经常超过 Function duration、需要横向扩展 worker、需要精细的 sandbox 生命周期管理。

**P2（完整平台）**：多用户 auth、team/org 权限、GitHub/GitLab 集成、secrets manager、network policy、human approval、subagent、long-term memory、billing、PR / preview。

## 9. 验收 benchmark

P0 是否成立不看功能多少，看这 8 条：

1. **端到端闭环**：输入任务后能看到事件流和最终报告。
2. **隔离执行**：文件读写和命令都发生在 workspace/sandbox 中，不污染平台代码。
3. **事件可观测**：每步 model step、tool call、tool result、final artifact 在 UI 或 DB 可见。
4. **工具受控**：路径不越出 workspace；命令有 timeout；输出有截断。
5. **状态可恢复查看**：SSE 断开后刷新仍能从 DB 看到已保存事件与结果。
6. **多轮会话与会话恢复**：同一 Session 内追问能复用 workspace、看到上一轮文件与对话历史；离开后重新进入，对话历史从 DB 恢复、workspace 从快照 resume。
7. **架构可演进**：agent loop 独立在 `src/server/agent`，未来可平移到 worker/独立服务。
8. **范围可解释**：文档明确 P0/P1/P2，说明为什么不做登录、计费、PR、自动 hibernate 编排。

## 10. Demo Happy Path

输入：`读取这个仓库，找出所有 TODO，生成一份报告`

期望：

- 至少发生一次 `search_text` 工具调用。
- 生成 Markdown artifact。
- 报告包含 TODO 的文件路径、行号、内容摘要。
- run 状态为 `completed`。

**多轮追问**（同一 Session 第二轮）：

输入：`把这些 TODO 按优先级排序，写进 PRIORITY.md`

期望：

- 复用同一 workspace（看得到第一轮的文件和上下文）。
- 发生 `write_file` 工具调用，在 workspace 内生成 `PRIORITY.md`。
- agent「记得」第一轮找到的 TODO（对话历史喂给 LLM）。
- 过两天回来打开此会话，对话历史照常，workspace 从 snapshot 恢复后可继续。

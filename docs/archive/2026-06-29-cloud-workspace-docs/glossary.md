# Glossary — Cloud Workspace P0

> 用途：先把词讲清楚，避免把企业级完整方案和 P0 demo 混在一起。

## Agent-in-Sandbox

Agent loop 在 sandbox 内运行，而不是在 control plane 里运行。

P0 判断标准：

- control plane 可以启动 run。
- control plane 可以取消 run。
- control plane 可以接收事件。
- 但 LLM 推理循环、工具调用、文件修改发生在 sandbox 内。

## Control Plane

可信服务端。当前项目里主要是 Next.js API route + server modules。

职责：

- 鉴权和权限判断
- 创建/更新 Run 状态
- 调度 sandbox
- 签发 scoped run token
- 接收 sandbox 上报事件
- 给 UI 提供 REST/SSE API

它可以持有 Postgres、Redis、LLM 路由配置等服务端凭证。

## Sandbox

不可信执行环境。可以是 Vercel microVM，也可以是 local 模式。

职责：

- 保存 workspace 文件
- 运行 agent daemon
- 执行 agent loop
- 执行工具：read/write/list/exec
- 把事件上报给 control plane

不能持有：

- Postgres 凭证
- Redis 凭证
- 长期 user token
- 跨 workspace 权限

## Scoped Run Token

control plane 为某一次 run 签发的短期 token。

它只允许 sandbox 做和当前 run 相关的有限动作，例如：

- 上报事件
- 标记工具调用
- 读取/写入当前 workspace 的文件

P0 可以先用简化 token，但接口语义要保留：token 必须绑定 `workspace_id` 和 `run_id`。

## Workspace

用户视角的工作空间。

企业级定义：

- 文件
- 成员
- agent run 历史
- memory
- skill
- sandbox 生命周期

P0 定义：

- 一组文件
- 一个可复用 sandbox
- 一组 run 历史

## Run

一次 agent 执行。

最小字段：

- `id`
- `workspace_id`
- `status`
- `prompt`
- `started_at`
- `completed_at`
- `last_heartbeat_at`
- `error`

Run 必须有终态：

- `completed`
- `failed`
- `cancelled`
- `timeout`

## Session

多轮对话容器。

P0 可以弱化为“同 workspace 下的一组 run”。如果做多轮，Session 保存用户消息和 assistant 消息；如果不做多轮，不应该阻塞 P0。

## AgentEvent

agent 执行期间产生的事实事件。

例子：

- `run.started`
- `llm.attempt_started`
- `tool_call.started`
- `tool_call.completed`
- `file.written`
- `run.completed`

P0 原则：UI 能展示的执行过程，必须来自 event，而不是只靠内存日志。

## ToolCall

一次工具调用的结构化记录。

例子：

- `read_file`
- `write_file`
- `list_files`
- `run_command`

P0 至少要能看到：

- 工具名
- 参数
- 状态
- 结果或错误

## Outbox

sandbox 本地事件缓冲区。

生产级定义：sandbox 先写本地 outbox，再由 forwarder 幂等上报 control plane。

P0 简化：可以先直接 HTTP 上报，但要承认这是简化版；未来再补 outbox + ack offset。

## Ingest API

control plane 接收 sandbox 事件的 API。

生产级要求：

- 校验 scoped run token
- 幂等写入
- `event_id = run_id:seq`
- 更新 `last_acked_seq`

P0 可以先做到：

- 只允许当前 run 上报
- event 有 seq
- 重复 event 不破坏状态

## Warm Sandbox

已经启动且可复用的 sandbox。

P0 只需要证明：

- 同一个 workspace 第二次 run 不重新冷启动。
- 文件仍在。
- agent daemon 仍可用。

## Cold Start

从无 sandbox 到可执行 run 的启动过程。

Vercel microVM 可能接近 50s；local 模式会更快。面试时要明确区分“真实云冷启”和“本地开发模式”。

## Freeze / Thaw

长时间不用时，把 sandbox 文件系统打包到 OSS；下次再恢复。

P0 不做。它属于 P1，因为它引入 OSS、快照一致性、outbox flush、生命周期编排。

## Memory

agent 从历史中沉淀出来的长期知识。

P0 不做。只在架构里作为未来演进讲。

## Skill

workspace 级可复用能力或工具包。

P0 不做 proposal/approval/installation 流程。内置工具可以算 runtime capability，不等于完整 Skill 系统。

## Fact Source

事实源。当前设计里是 Postgres。

意思是：

- UI 刷新后能从 Postgres 重建状态。
- run 状态、事件、工具调用最终以 Postgres 为准。
- sandbox 本地状态只是运行时缓存或 WAL。

## Trust Boundary

可信和不可信系统之间的边界。

本项目的边界在 sandbox 外侧：

```text
trusted:   Browser auth -> Control Plane -> Postgres
untrusted: Sandbox -> local files -> agent tools
```

sandbox 可以执行用户/agent 生成的代码，所以默认不可信。

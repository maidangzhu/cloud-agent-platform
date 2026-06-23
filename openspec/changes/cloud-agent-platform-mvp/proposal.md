## Why

构建一个 Cloud Agent Platform：用户提交一段自然语言任务（例如「读取这个仓库、找出所有 TODO、生成一份报告」），平台启动一个自主 agent，在云端隔离环境中调用 LLM 推理、调用工具、循环迭代直至完成，并返回结构化结果。当前仓库是一个空的 Next.js 脚手架，需要从零交付一个能跑通端到端主链路的 MVP，并用架构文档说明生产级演进。

核心设计主张：严格区分三类状态边界 —— 控制面状态（Postgres，唯一事实源）、执行状态（sandbox 文件系统）、runtime 状态（agent transcript，adapter 细节）。LLM 是规划器，不是无边界执行器；所有副作用必须经过 工具 schema 校验 → policy guard → sandbox 执行 → 事件落库。

## What Changes

- 新增 **邀请码门禁**：轻量访问控制，服务端二次校验，替代登录/计费。
- 新增 **多轮会话**：`Session` 会话容器 + `Message` 对话消息，支持追问、会话恢复，workspace 会话内复用。
- 新增 **Run 编排与状态机**：创建 run、状态流转、心跳、取消、中断恢复。
- 新增 **沙箱隔离层**：统一 `Sandbox` 接口 + 双实现（本地临时目录 / Vercel Firecracker microVM），path guard 限制在 workspace 内；命名沙箱复用 + snapshot/resume 会话内持久。
- 新增 **工具系统**：`list_files / read_file / search_text / write_file / run_command`，统一 schema 校验、超时、输出截断、命令白名单。
- 新增 **Agent runtime 集成**：基于 Pi（`@earendil-works/pi-agent-core` + `pi-ai`），`beforeToolCall` 做 policy guard，`subscribe` 做事件同步；无 key 时回退 faux provider。
- 新增 **事件持久化**：AgentEvent / ToolCall / Artifact 落 Postgres，单调 seq 保证顺序，SSE 流式推送且断线后可从 DB 恢复。
- 新增 **Web UI**：多轮对话界面、事件时间线、最终报告展示。
- 新增 **开发流程约束**：全程 TDD（faux LLM + 本地沙箱保证测试零外部依赖），分阶段交付，每阶段完成后停下等人工检查，进度用 OpenSpec 记录。

## Capabilities

### New Capabilities

- `invite-gate`: 邀请码访问控制，服务端可信校验。
- `session-management`: 多轮会话容器、对话消息持久化、会话恢复。
- `run-orchestration`: Run 生命周期、状态机、心跳、取消与中断恢复。
- `sandbox-isolation`: 统一沙箱接口、path guard、本地/Vercel 双实现、workspace 复用与 snapshot/resume。
- `tool-system`: 受控工具集，schema 校验、policy guard、超时与输出截断。
- `agent-runtime`: Pi agent loop 编排、LLM 集成、工具绑定、maxSteps/时长约束。
- `event-persistence`: 事件流落库、单调 seq、artifact 存储、SSE 与刷新恢复。
- `web-ui`: 多轮对话界面、事件时间线、报告面板。

### Modified Capabilities

<!-- 无现有 spec，全部为新增 -->

## Impact

- 新增依赖：`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@vercel/sandbox`、`@prisma/client`、`prisma`、`vitest`。
- 新增数据库：Neon Postgres（Session / Workspace / Message / Run / AgentEvent / ToolCall / Artifact 七表）。
- 新增 API 路由：`/api/invite`、`/api/sessions`、`/api/sessions/[id]`、`/api/sessions/[id]/runs`、`/api/runs/[runId]`、`/api/runs/[runId]/events`、`/api/runs/[runId]/cancel`。
- 复用现有：`src/app/providers.tsx`（React Query）、`src/stores/use-app-store.ts`（zustand）、Tailwind。
- 部署：Vercel + Neon。

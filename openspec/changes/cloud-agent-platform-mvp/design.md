## Context

笔试题要求构建 Cloud Agent Platform，重点考察 Agent 编排调度、沙箱隔离、LLM 集成与工具调用、架构可扩展性。约束：时间紧（约 24h 墙钟，5–8h 有效开发量）、必须能跑通端到端、全程 TDD、仓库内零个人隐私信息。当前是空的 Next.js 16 App Router 脚手架（Tailwind 4 + React Query + zustand + pnpm + Node 22）。

参考架构：Vercel Open Agents（MIT），其核心边界 `Web → Agent Workflow → Sandbox VM` 与本题高度契合。本项目借鉴其三层边界与 `Sandbox` 接口形状，但从零实现一个更小的任务闭环。

## Goals / Non-Goals

**Goals:**
- 跑通端到端主链路：prompt → 创建 session/run → 初始化/复用 workspace → agent 调用工具 → 事件落库 → 最终报告。
- 多轮会话：同一 Session 内追问、对话历史连续、workspace 复用、沙箱回收后从 snapshot 恢复。
- 三类状态边界清晰分离：控制面（Postgres）/ 执行（sandbox）/ runtime（transcript）。
- 工具受控：路径限制在 workspace、命令白名单、超时、输出截断。
- 事件可观测、可恢复：每步落库，SSE 断开后刷新可从 DB 重建。
- 全程 TDD：确定性逻辑先写测试；纯逻辑单元测试离线，业务流程一律用集成测试跑通真实 Vercel 沙箱 + Neon + 真实 LLM，后端全绿才开前端。
- 真实部署到 Vercel + Neon。

**Non-Goals:**
- OAuth / 多租户 / 计费；GitHub App / 自动 PR；durable workflow；**自动 hibernate 生命周期编排（snapshot/resume 的③）**；subagent；向量记忆。这些仅写进架构文档作为 P1/P2 演进。（注：多轮会话与 snapshot/resume①② 已纳入本期 Goals。）

## Decisions

**D1. Agent Runtime 用 Pi（`@earendil-works/pi-agent-core` + `pi-ai`）而非自建 loop 或 AI SDK。**
理由：Pi 的 `Agent` 类提供现成的 tool-call 循环；`beforeToolCall` hook 正好是 policy guard 挂点，`subscribe(event)` 正好是事件同步挂点，`AgentTool`（TypeBox schema）天然适配工具系统。pi-ai 原生支持 OpenAI 兼容协议。
备选：自建 loop（可控但要写更多胶水与测试桩）、AI SDK ToolLoopAgent（要引入 AI SDK）。

**D2. 沙箱用「统一 interface + 唯一 VercelSandbox 实现」。**
`Sandbox` 接口借鉴 Open Agents 形状（`readFile/writeFile/stat/mkdir/readdir/exec/stop/getState` + `snapshot`）。只实现 `VercelSandbox`（`@vercel/sandbox`，Firecracker microVM）；业务测试与生产共用真实沙箱（无 LocalSandbox）。保留接口抽象以便未来接别的后端。
理由：测过的就是线上跑的，避免本地模拟与生产行为不一致；snapshot/resume 等能力也能真实验证。代价是业务测试需 Vercel 凭据与网络（纯逻辑单元测试仍离线）。

**D3. Postgres 是唯一事实源，sandbox 只存状态引用。**
Run/Workspace/AgentEvent/ToolCall/Artifact 落 Prisma+Postgres。`AgentEvent` 用 `@@unique([runId, seq])` 保证事件顺序。Pi 的 transcript 不作为平台事实源（可序列化用于调试/continuation）。
理由：前端展示、审计、刷新恢复都依赖 DB；runtime transcript 易丢失、难查询。

**D4. P0 在 Vercel Function 内联跑 agent loop + SSE，不引入 queue/durable workflow。**
`POST /api/runs` 触发 agent worker 模块（`src/server/agent`）。SSE 路由只读 DB events 增量推送，与 loop 解耦，已具备「执行/观察分离」雏形。`runtime='nodejs'`、`maxDuration=800`。
理由：48h 内最快闭环；模块边界已留好，P1 可平移到独立 worker/queue 而不动 UI。

**D5. 仅 OpenAI 兼容协议；所有业务流程连真实 LLM，无 mock 回退。**
`model.ts` 用 pi-ai 构造 `api: "openai-completions"` 的 model，`baseUrl` 取 `OPENAI_BASE_URL`（指向中转站）、id 取 `LLM_MODEL`、apiKey 取 `OPENAI_API_KEY`；`OPENAI_API_KEY` 为空则直接抛错。不接 Anthropic 原生 provider（中转站统一走 OpenAI 协议即可）。
理由：用户环境恒有中转站 key，faux 回退是死代码且会让集成测试误走真 LLM 而不自知；单协议降低集成面。run-agent 集成测试连真实 LLM，happy path 断言放宽，确定性边界（timeout/cancelled/failed）由编排层触发。

**D6. 中断/刷新恢复用心跳 + derivedUiState。**
`lastHeartbeatAt` 每 step 刷新；`GET /api/runs/:id` 据状态与心跳新鲜度推导 `idle/running/possibly_running/interrupted/completed/failed/cancelled`。DB 是 source of truth，前端不靠本地内存判断存活。

**D7. 多轮会话模型：Session 容器 + Message 对话 + Run 执行。**
`Session` 是长期会话容器，`Message`（user/assistant）按行存对话，`Run` 是 Session 下一次执行。`Message`（用户视角对话）与 `AgentEvent`（执行细节）分离。
理由：贴合 Claude Code Cloud 类比，支持追问；两层 message 分离让对话展示与执行审计各司其职。
备选：单任务模型（一个 Run = 一次会话，无 Session/Message）——更简单但不支持多轮，已否决。

**D8. workspace 会话内持久（跨请求、跨沙箱实例）用 snapshot/resume 分层，做①②不做③。**
① persistent 命名沙箱 `getOrCreate` 文件延续（必做）；② 停止前 `snapshot()`、重进从 `snapshotId` resume（增强）；③ 自动 hibernate 生命周期编排（不做，P1）。Workspace 绑 Session，存 `sandboxName/sandboxState/snapshotId`。
理由：①② 是 Vercel SDK 原生能力，覆盖「过几天回来继续」；③ 是 Open Agents 那套 lifecycle workflow 的复杂度，P0 不值得。
取舍：snapshot/resume 全程在真实 Vercel 沙箱上验证（命名沙箱复用 + 真快照恢复），无近似、无「测不到」的折扣；代价是这些测试需 Vercel 凭据与网络。

## Risks / Trade-offs

- **Pi API 细节差异** → 阶段 3 直连真实 LLM 打通编排；已读官方 README 确认核心 API。
- **Vercel Sandbox 依赖网络/凭据** → 业务测试需真实沙箱（已打通：PAT 凭据 + 实测从本地拉起 microVM 跑通）。本机访问 vercel.com 若被墙需开全局代理；部署在 Vercel 上无此问题。纯逻辑单元测试不受影响（离线）。
- **多轮 + snapshot 增加工期** → 相对单任务约 +60~80% 量；按 ①（文件延续）先跑通多轮、②（snapshot/resume）后做的渐进交付，任何时刻有可交付版本。
- **时间不足** → 即使最终部署超时，MVP 仍以「本地连真实 Vercel 沙箱跑通主链路 + 多轮会话 + 完整测试 + 文档」成立；线上部署与 snapshot/resume 为加分项。
- **Vercel Function 时长上限** → 设 maxSteps（60）、每工具 timeout、run 级 wall time buffer；超限标记 timeout，已落事件保留。

## Migration Plan

新建项目，无存量迁移。部署：Neon 建库 → `prisma db push`/`migrate deploy` → Vercel CLI 部署 → 配环境变量（`DATABASE_URL`、`INVITE_CODES`、`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`LLM_MODEL` 等；沙箱在 Vercel 上 OIDC 自动注入）。回滚：Vercel 即时回退到上一个 deployment。

## 开发流程约束（关键工作方式）

- **分阶段交付**：6 个阶段（地基 → 纯逻辑 → 工具+沙箱 → agent 编排 → API → UI+真实接入+部署）。
- **每阶段完成后必须停下**，等人工检查通过，才进入下一阶段。不一次性铺开所有实现。
- **进度用 OpenSpec 记录**：`openspec/changes/cloud-agent-platform-mvp/tasks.md` 按阶段分组勾选；每完成一项勾一项。
- **全程 TDD**：每阶段先写测试 → 实现 → 跑绿，再停下。

## Open Questions

- demo repo 的具体内容与规模（阶段 2 定，保持中性零 PII）。
- E2E 用 Playwright 还是脚本级 happy path（阶段 5 视时间定）。

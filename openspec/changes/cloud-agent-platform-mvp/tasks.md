# Tasks — Cloud Agent Platform MVP

> 工作方式：每个阶段（## 分组）完成后停下，等人工检查通过，再进入下一阶段。每阶段 TDD：先写测试 → 实现 → 跑绿。
> 会话模型：多轮（Session + Message）。workspace 会话内持久（跨请求、跨沙箱实例）分层：①persistent 复用（必做）/ ②snapshot+resume（增强）/ ③自动 hibernate 编排（不做，P1）。

## 0. 地基（依赖 + 配置）

- [x] 0.1 安装运行时依赖：`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@vercel/sandbox`、`@prisma/client`
- [x] 0.2 安装开发依赖：`vitest`、`prisma`
- [x] 0.3 配置 vitest（config + test 脚本），跑通空套件
- [x] 0.4 编写 Prisma schema（Session/Workspace/Message/Run/AgentEvent/ToolCall/Artifact 七表 + 枚举），`prisma generate`
- [x] 0.5 创建 `.env.example`（DATABASE_URL、INVITE_CODES、LLM key、SANDBOX_PROVIDER 等占位）
- [x] 0.6 验证 `pnpm build` 通过

## 1. 纯逻辑层（unit）

- [x] 1.1 写测试：Run 状态机（合法/非法转移、终态守卫）+ Session 状态（active/archived）
- [x] 1.2 实现 `run-status.ts`
- [x] 1.3 写测试：path guard（相对/绝对越权拒绝、合法放行）
- [x] 1.4 实现 `path-guard.ts`
- [x] 1.5 写测试：policy（命令白名单、高风险拒绝）
- [x] 1.6 实现 `policy.ts`
- [x] 1.7 写测试：事件 seq 单调与偏序（纯逻辑部分）
- [x] 1.8 全部 unit 测试跑绿

## 2. 工具层 + LocalSandbox（integration）

- [ ] 2.1 定义 `Sandbox` 接口（含 snapshot/getState）
- [ ] 2.2 写测试：LocalSandbox 读写、workspace 初始化、按 sessionId 复用目录
- [ ] 2.3 实现 `local-sandbox.ts` + `factory.ts`（getOrCreate：目录在则复用，不在则建+seed）
- [ ] 2.4 准备中性 demo-repo fixture（含 TODO/FIXME，零 PII）
- [ ] 2.5 写测试：5 个工具（越权拒绝、超时、输出截断、高风险 rejected、search_text 命中）
- [ ] 2.6 实现 `tools/registry.ts`（5 工具，TypeBox schema）
- [ ] 2.7 工具层 integration 测试跑绿

## 3. Agent loop 编排 + 多轮（faux LLM）

- [ ] 3.1 实现 `event-store.ts`（appendEvent/persistToolCall/persistArtifact）+ message 落库
- [ ] 3.2 实现 `model.ts`（真 key 解析 + faux 回退）
- [ ] 3.3 写测试：run-agent happy path（faux 脚本化 search_text → final answer → completed + 写 assistant Message）
- [ ] 3.4 实现 `run-agent.ts` 编排（getOrCreate workspace、挂 beforeToolCall/subscribe、跑 Pi Agent）
- [ ] 3.5 写测试：多轮上下文（第二轮 Run 能看到第一轮对话历史 + 复用 workspace 文件）
- [ ] 3.6 写测试：失败 → failed、超限 → timeout、取消 → cancelled（事件保留）
- [ ] 3.7 agent 编排测试跑绿

## 4. API 路由（route tests）

- [ ] 4.1 实现 Prisma client singleton + invite service
- [ ] 4.2 写测试 + 实现：`POST /api/invite`（服务端二次校验）
- [ ] 4.3 写测试 + 实现：`POST /api/sessions`（建会话 + workspace 准备）
- [ ] 4.4 写测试 + 实现：`POST /api/sessions/[id]/runs`（追加 message、触发 worker、复用 workspace）
- [ ] 4.5 写测试 + 实现：`GET /api/sessions/[id]`（会话历史 + 对话消息）
- [ ] 4.6 写测试 + 实现：`POST /api/runs/[runId]/cancel`
- [ ] 4.7 写测试 + 实现：`GET /api/runs/[runId]`（快照 + derivedUiState）
- [ ] 4.8 实现：`GET /api/runs/[runId]/events`（SSE，runtime=nodejs）
- [ ] 4.9 API 测试跑绿

## 5. UI 多轮对话 + 真实 LLM（可交付里程碑）

- [ ] 5.1 邀请码门禁页
- [ ] 5.2 对话界面：MessageList（多轮）+ EventTimeline + ReportPanel + ToolCallCard（借鉴 Open Agents 渲染模式，接 SSE）
- [ ] 5.3 接真实 LLM（OpenAI 协议中转站）跑一次本地多轮 demo（LocalSandbox：找 TODO → 追问排序写文件）
- [ ] 5.4 本地端到端自测（提交 → 事件流 → 报告 → 追问复用 workspace）

## 6. Vercel Sandbox + snapshot/resume + 部署

- [ ] 6.1 实现 `vercel-sandbox.ts`（getOrCreate + persistent 命名沙箱）—— ① 文件延续
- [ ] 6.2 本地 `vercel link` + `vercel env pull`，切 `SANDBOX_PROVIDER=vercel` 跑通真实 microVM
- [ ] 6.3 实现 snapshot + resume —— ② 快照恢复（停止前 snapshot，重进从 snapshotId resume）
- [ ] 6.4 Neon 建库 + `prisma migrate deploy`
- [ ] 6.5 Vercel CLI 部署 + 环境变量
- [ ] 6.6 补充 README 运行/部署说明；隐私自检（零 PII）；E2E happy path

> 文档（PRD / architecture / data-model / sandbox-research / ADR-0001 / CONTRIBUTING）已在规划阶段完成，实现中随变更同步维护。

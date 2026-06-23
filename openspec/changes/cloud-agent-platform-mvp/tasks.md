# Tasks — Cloud Agent Platform MVP

> 工作方式：每个阶段（## 分组）完成后停下，等人工检查通过，再进入下一阶段。每阶段 TDD：先写测试 → 实现 → 跑绿。
> 会话模型：多轮（Session + Message）。workspace 会话内持久（跨请求、跨沙箱实例）分层：①persistent 复用（必做）/ ②snapshot+resume（增强）/ ③自动 hibernate 编排（不做，P1）。

## 0. 地基（依赖 + 配置）

- [x] 0.1 安装运行时依赖：`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@vercel/sandbox`、`@prisma/client`
- [x] 0.2 安装开发依赖：`vitest`、`prisma`
- [x] 0.3 配置 vitest（config + test 脚本），跑通空套件
- [x] 0.4 编写 Prisma schema（Session/Workspace/Message/Run/AgentEvent/ToolCall/Artifact 七表 + 枚举），`prisma generate`
- [x] 0.5 创建 `.env.example`（DATABASE_URL、INVITE_CODES、LLM key、Vercel 凭据 等占位）
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

## 2. 工具层 + VercelSandbox（integration，真沙箱）

- [x] 2.1 定义 `Sandbox` 接口（`readFile/writeFile/readdir/exec/snapshot/stop/getState`）
- [x] 2.2 实现 `vercel-sandbox.ts` + `factory.ts`（`getOrCreate` 命名沙箱：活着复用、回收则重建+seed；凭据用 `vercel-credentials.ts`）
- [x] 2.3 写测试（真沙箱）：读写、workspace 初始化、按 sessionId 复用命名沙箱
- [x] 2.4 准备中性 demo-repo fixture（含 TODO/FIXME，零 PII），seed 进沙箱
- [x] 2.5 写测试（真沙箱）：5 个工具（越权拒绝、超时、输出截断、高风险 rejected、search_text 命中）
- [x] 2.6 实现 `tools/registry.ts`（5 工具，TypeBox schema，复用 path-guard + policy）
- [x] 2.7 工具层 integration 测试跑绿（真沙箱）

## 3. Agent loop 编排 + 多轮（真实 LLM）

- [x] 3.1 实现 `event-store.ts`（appendEvent/persistToolCall/persistArtifact）+ message 落库
- [x] 3.2 实现 `model.ts`（真 key 解析；无 key 抛错）
- [x] 3.3 写测试：run-agent happy path（真实 LLM 探索仓库 → 工具调用 → completed + 写 assistant Message）
- [x] 3.4 实现 `run-agent.ts` 编排（getOrCreate workspace、挂 beforeToolCall/subscribe、跑 Pi Agent）
- [x] 3.5 写测试：多轮上下文（第二轮 Run 能看到第一轮对话历史 + 复用 workspace 文件）
- [x] 3.6 写测试：失败 → failed、超限 → timeout、取消 → cancelled（事件保留）
- [x] 3.7 agent 编排测试跑绿
- [x] 3.8 policy 宽松模式：移除白名单，改为 denylist（只拦截 rm -rf/sudo/dd 等高危；放行 git/npx/node/curl/ssh 等）
- [x] 3.9 修复 cancel 逻辑：先检查 cancel_requested 再更新状态（避免 provisioning_workspace 覆盖预设取消）
- [x] 3.10 多轮场景集成测试（npx maidang whoami → songs --year 2025 → 写 workspace 文件 → 验证文件内容含真实歌手名）
- [x] 3.11 外部仓库集成测试（git clone + npx 在真沙箱执行，验证沙箱网络连通）
- [x] 3.12 session 执行过程 viewer（`maidang-multiturn-viewer.integration.test.ts`，按事件流格式化输出 AI 推理过程）
- [x] 3.13 docs/adr/0003：执行事件分表存储 vs parts 内嵌对比决策（生产可扩展性、多维查询、审计追踪）

## 4. API 路由（route tests）

> 接口规范（统一 `{code,message,data}` 信封、错误码、DTO、SSE 事件格式）见 `docs/api-contract.md` + `src/lib/api-contract.ts`（前后端共用，已先行定义并测试）。本阶段所有端点按此契约实现与测试。

- [x] 4.0 定义接口契约：`docs/api-contract.md` + `src/lib/api-contract.ts`（信封/错误码/DTO/SSE）+ 单元测试
- [x] 4.1 实现 `invite-service.ts`（isValidInviteCode + hashCode）+ 单元测试（有效码/无效码/trim/未配置）
- [x] 4.2 实现 `run-service.ts`（derivedUiState 按心跳新鲜度推导 + toSessionDTO/toRunDTO/toMessageDTO/toAgentEventDTO/toToolCallDTO/toArtifactDTO）+ 单元测试（全状态覆盖 + 心跳时效三档）
- [x] 4.3 写测试 + 实现：`POST /api/invite`（有效码→200、无效→401、缺字段→400、非JSON→400）
- [x] 4.4 写测试 + 实现：`POST /api/sessions`（建会话 + inviteCodeHash 存库、无prompt→默认title、无效码→401）
- [x] 4.5 写测试 + 实现：`GET /api/sessions/[id]`（含消息列表 + runs 列表、404）
- [x] 4.6 写测试 + 实现：`POST /api/sessions/[id]/runs`（建Run + 写user Message + fire-and-forget触发runAgent、session不存在→404、缺prompt→400）
- [x] 4.7 写测试 + 实现：`GET /api/runs/[runId]`（events + toolCalls + artifacts + derivedUiState、404）
- [x] 4.8 写测试 + 实现：`POST /api/runs/[runId]/cancel`（running→cancel_requested、终态→409/2001、404）
- [x] 4.9 实现：`GET /api/runs/[runId]/events`（SSE streaming：snapshot→业务事件→ping→done；runtime=nodejs）+ 测试（终态立即done、content-type、snapshot含已有事件、404）
- [x] 4.10 全链路集成测试：session→run→手动植入9事件+工具调用+artifact→验证所有端点数据一致→cancel报409
- [x] 4.11 取消链路测试：running→cancel_requested→derivedUiState=cancelled，GET run同步反映
- [x] 4.12 多轮对话链路测试：两轮Run共享session消息历史，GET /api/sessions/:id返回全部messages+runs
- [x] 4.13 API 测试跑绿（30个集成测试全通过）

## 5. UI 多轮对话 + 真实 LLM（可交付里程碑）

- [x] 5.1 邀请码门禁页（`/invite`：输入邀请码 → 校验 → 建 Session → 跳转对话页）
- [x] 5.2 对话界面：`/chat/[sessionId]`（MessageList 多轮 + RunTimeline 执行事件 + ToolCallCard 工具折叠 + SSE 实时接入）
- [x] 5.2a AgentEventDTO 新增 `payload`（args/result/error）字段，SSE 事件携带完整工具调用数据，前端无需额外请求
- [x] 5.2b `useRunEvents` SSE hook（EventSource 订阅 + snapshot 重连 + done 关闭）
- [ ] 5.3 接真实 LLM（OpenAI 协议中转站）跑一次多轮 demo（真实 Vercel 沙箱：找 TODO → 追问排序写文件）
- [ ] 5.4 本地端到端自测（提交 → 事件流 → 报告 → 追问复用 workspace）

## 6. 前端状态管理重构 + snapshot/resume + 部署

> 决策依据：[ADR-0004](../../docs/adr/0004-frontend-state-management-and-realtime-sync.md) —— 双源合并策略（DB First, SSE Enhancement），处理刷新、断线重连、多标签页等边缘情况。

### 6.0 前端状态管理重构（DB + SSE 双源合并）✅

- [x] 6.0.1 提取 `useSessionState` hook（合并 DB + SSE 数据，管理 activeRunId）
- [x] 6.0.2 改进 `useRunSSE`：心跳检测（30s 超时）、自动重连（3 次）、降级到轮询
- [x] 6.0.3 `useQuery` 条件化 `refetchInterval`（SSE 连接时不轮询，断开时 5s 轮询）
- [x] 6.0.4 实现 `findRunningRun` 辅助函数（检测 `provisioning_workspace` / `running` 状态）
- [x] 6.0.5 处理浏览器休眠恢复（`visibilitychange` 事件 → 重连 SSE）
- [x] 6.0.6 UI 连接状态指示器（🟢 实时连接 / 🟡 轮询中）
- [x] 6.0.7 测试场景 S1-S3（已通过 3 个测试：S1 发送新消息、S2 刷新 running、S3 刷新 completed）
- [x] 6.0.8 测试边缘情况 E1、E8（已通过 2 个测试：SSE 失败降级、快速连发保护）
- [x] 6.0.9 移除现有的"SSE done → refetch"逻辑（已重构 ChatPage，删除旧 useRunEvents）

**测试结果**：148 passed | 6 skipped (154)
- useRunSSE: 5 tests passed
- useSessionState: 5 tests passed (S1, S2, S3, E1, E8)

### 6.0+ UI 优化与完善 ✅

- [x] 6.0.10 修复实时渲染：SSE 事件立刻渲染（tool_call_started/completed/model_step）
- [x] 6.0.11 修复事件持久化：使用 useRef 缓存已完成 run 的 events
- [x] 6.0.12 前端无障碍改进：shadcn/ui 组件库 + WCAG 完整支持
- [x] 6.0.13 Agent 能力扩展：run_command 支持 npx、git clone、安装依赖等
- [x] 6.0.14 修复刷新后事件显示：GET /api/sessions/:id 返回 run.events
- [x] 6.0.15 平铺显示所有事件：移除展开/收起，RunTimeline 平铺渲染工具调用、model_step、状态
- [x] 6.0.16 使用 flex-col-reverse 实现自动滚动：无需 scrollIntoView
- [x] 6.0.17 修复 SSE 错误处理：controller.close() 双重保护
- [x] 6.0.18 路由重构：主页 + 历史会话列表
  - `/` 主页：居中输入框 + 左侧历史列表
  - `/chat/[sessionId]` 对话详情
  - 创建时机：用户发送第一个 query 时创建 session
  - Session title：用户的第一句话
- [x] 6.0.19 添加 Loading 状态：主页提交后显示转圈圈 + "Creating conversation…"
- [x] 6.0.20 添加骨架屏：ChatPage 刷新时显示 Skeleton
- [x] 6.0.21 全局侧边栏布局：主页 + ChatPage 共享 Sidebar 组件

**UI 改进总结**：
- ✅ 实时渲染：SSE 事件立刻显示，无需等待 done
- ✅ 事件持久化：刷新后仍能看到历史工具调用
- ✅ 无障碍：shadcn/ui + WCAG 完整支持
- ✅ 自动滚动：flex-col-reverse，无闪烁
- ✅ 骨架屏：内容优先，感知性能优化
- ✅ 全局导航：左侧栏统一管理 sessions

### 6.2 Vercel 部署 + 环境变量配置 ✅

- [x] 6.2.1 创建 `vercel.json`（构建配置、函数超时、headers）
- [x] 6.2.2 配置域名：sandbox.maidang.me
- [ ] 6.2.3 Vercel Dashboard 配置环境变量（DATABASE_URL、INVITE_CODES、LLM、VERCEL_TOKEN）
- [ ] 6.2.4 生产部署：`vercel --prod`
- [ ] 6.2.5 验证线上功能：邀请码 → 创建对话 → 工具调用 → SSE 实时渲染

### 6.3 README 运行/部署说明 + 隐私自检 + E2E happy path

> 已提前完成/并入：VercelSandbox 实现与命名沙箱复用（①文件延续）并入阶段 2；`vercel link` + `vercel env pull`（凭据用 PAT/OIDC，见 `vercel-credentials.ts`）已配；Neon 建库 + `prisma db push` 已完成（7 表已建）。

- [ ] 6.1.1 实现 snapshot + resume —— ② 快照恢复（停止前 `snapshot()`，重进从 `snapshotId` resume），真沙箱验证

### 6.2 Vercel 部署

- [ ] 6.2.1 Vercel CLI 部署 + 环境变量（`DATABASE_URL` / `INVITE_CODES` / `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `LLM_MODEL`；沙箱 OIDC 自动注入）
- [ ] 6.2.2 补充 README 运行/部署说明；隐私自检（零 PII）；E2E happy path

> 文档（PRD / architecture / data-model / sandbox-research / ADR-0001 / CONTRIBUTING）已在规划阶段完成，实现中随变更同步维护。

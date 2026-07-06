# 前端方向 — Vercel Chatbot 参考方案

## 1. 目标

下一版前端以 `/Users/zhujianye/maidang/references/vercel-chatbot` 作为主要 UI 参考。

参考范围：

- 视觉风格
- 信息密度
- sidebar 行为
- chat/message 组合方式
- artifact preview 和 artifact panel
- 组件 primitives
- motion 和响应式行为

参考项目不决定我们的后端数据流。

我们的平台不是浏览器直接从模型流式接收内容。浏览器接收的是 Control Plane SSE endpoint 里的 run events。Agent loop 会在 sandbox 内运行，sandbox 通过 ingest APIs 上报持久化事实。因此，Vercel Chatbot 的 AI SDK stream plumbing 不是本项目的事实源。

## 2. 参考文件

关键参考文件：

```text
/Users/zhujianye/maidang/references/vercel-chatbot/components/chat/artifact.tsx
/Users/zhujianye/maidang/references/vercel-chatbot/hooks/use-artifact.ts
/Users/zhujianye/maidang/references/vercel-chatbot/components/chat/document.tsx
/Users/zhujianye/maidang/references/vercel-chatbot/components/chat/document-preview.tsx
/Users/zhujianye/maidang/references/vercel-chatbot/components/chat/artifact-actions.tsx
/Users/zhujianye/maidang/references/vercel-chatbot/components/chat/version-footer.tsx
/Users/zhujianye/maidang/references/vercel-chatbot/artifacts/text/client.tsx
/Users/zhujianye/maidang/references/vercel-chatbot/components/chat/app-sidebar.tsx
/Users/zhujianye/maidang/references/vercel-chatbot/components/chat/sidebar-history.tsx
/Users/zhujianye/maidang/references/vercel-chatbot/components/ui/sidebar.tsx
/Users/zhujianye/maidang/references/vercel-chatbot/app/globals.css
```

可借鉴依赖：

```text
lucide-react
framer-motion or motion
sonner
date-fns
usehooks-ts
use-stick-to-bottom
streamdown
@streamdown/cjk
@streamdown/code
@streamdown/math
@streamdown/mermaid
@tailwindcss/typography
tailwindcss-animate
```

默认不要引入 AI SDK。只有当它对 sandbox runner 或 LLM proxy 的模型/stream parsing 有明确帮助时，才作为实现选项。浏览器端应保持 API/SSE 驱动。

## 3. 产品布局

目标应用布局：

```text
App Shell
  Left Sidebar
    User
    New workspace
    Workspaces
    Threads in active workspace

  Main Conversation
    Header
      workspace title
      thread title
      run status
    Messages
      user messages
      assistant messages
      tool/event cards
      artifact preview cards
    Composer
      prompt textarea
      submit/cancel

  Artifact Panel
    hidden by default on desktop
    opens as right-side panel on desktop
    opens as full-screen overlay on mobile
```

整体应该比当前 dark-only prototype 更接近 Vercel Chatbot：

- 安静的中性色板
- 紧凑 sidebar
- 精确边框
- 低视觉噪音
- 稳定 app shell
- artifact panel 是一等工作区表面

三栏是主次关系，不是平级面板（详见 [design-system.md](./design-system.md) 4.0）：sidebar 低频、chat 是唯一输入通道、artifact panel 默认隐藏按需弹出。这与 Vercel Chatbot 原版的布局意图一致，不需要改变。

产品主路径是 [ADR-0013](./decisions/0013-mechanism-deep-dive-refinement.md) 定义的两阶段机制深挖（Stage 1 概览 → 用户选择 → Stage 2 深挖），不是一次性问答。UI 上体现为同一 thread 内的连续 run，conversation 里能看到"概览完成 → 等待你选择 → 深挖中 → 深挖完成"的连续状态。

## 4. 概念上要借鉴什么

### 4.1 Sidebar

参考：

- `components/chat/app-sidebar.tsx`
- `components/chat/sidebar-history.tsx`
- `components/ui/sidebar.tsx`

借鉴：

- collapsible sidebar
- icon rail mode
- 小字号
- 分组导航
- footer user nav
- loading skeletons
- active item styling
- destructive actions behind confirmation

适配：

- 把 “History” 换成两个分组：
  - `Workspaces`
  - `Threads`
- user footer 不再显示 credits/余额（[ADR-0015](./decisions/0015-usage-telemetry-and-ops-priorities.md) 已改为用量遥测，非常驻 UI 元素）。
- `New chat` 改为 `New workspace` 和/或 `New thread`。

不要照搬：

- chat-only history API assumptions
- Auth.js-specific user types

### 4.2 Conversation

参考：

- `components/chat/messages.tsx`
- `components/chat/message.tsx`
- `components/chat/multimodal-input.tsx`
- `components/ai-elements/message.tsx`
- `components/ai-elements/tool.tsx`

借鉴：

- 居中的 conversation column
- composer 固定在底部
- message actions 只在 hover 或必要时出现
- tool calls 渲染为紧凑可展开行
- 清晰的 run status 和 streaming state

适配：

- message stream 来自：
  - `GET /api/threads/:threadId`
  - `GET /api/runs/:runId/events`
  - Control Plane SSE
- tool 和 model steps 来自 `AgentEventDTO`，不是 AI SDK `parts`。

### 4.3 Artifact Preview

参考：

- `components/chat/document.tsx`
- `components/chat/document-preview.tsx`

借鉴：

- artifact preview card 出现在 message/timeline 内
- 点击区域捕获 bounding box，用于 panel 动画
- preview card 显示 title、kind icon、loading state 和 content snippet
- 创建中和已完成的 tool state 使用不同 label/icon

适配：

- Vercel Chatbot 使用 `Document`。
- 我们的领域对象是 `Artifact`。
- 组件命名替换：
  - `DocumentPreview` -> `ArtifactPreview`
  - `DocumentToolCall` -> `ArtifactToolCall`
  - `DocumentToolResult` -> `ArtifactToolResult`

### 4.4 Artifact Panel

参考：

- `components/chat/artifact.tsx`
- `hooks/use-artifact.ts`
- `components/chat/artifact-actions.tsx`
- `components/chat/version-footer.tsx`

借鉴：

- desktop 右侧 panel
- mobile 全屏 overlay
- 从 preview bounding box 打开的平滑动画
- local artifact UI state
- header 包含 close、title、updated time、generating/saving state
- 按 artifact kind 选择 renderer
- 历史版本 footer
- action toolbar

适配：

- artifact state 由我们的 API 和 SSE events 驱动。
- 不依赖 `UseChatHelpers`。
- actions 调用我们的 API，或发送普通 thread message。

P0 artifact panel 支持：

- markdown/text artifacts
- copy
- download
- open latest version
- 如果已有版本，支持 previous/next
- diff 成本高时放 P1

P1 artifact panel 支持：

- code artifacts
- tables
- images
- manual edit and save
- restore version
- request polish/suggestions via thread message

### 4.5 Design Tokens

参考：

- `app/globals.css`

借鉴 token 结构：

- `--background`
- `--foreground`
- `--card`
- `--muted`
- `--border`
- `--sidebar`
- `--sidebar-foreground`
- `--sidebar-accent`
- `--shadow-card`
- `--shadow-float`
- `--ease-spring`
- `--ease-smooth`

不要整文件盲拷。把 token 合并进当前 Tailwind 4 setup，并保持中性色板。

## 5. 不要照搬什么

不要直接复制：

- AI SDK `useChat` browser data model
- `UseChatHelpers` component props
- `/api/chat` route assumptions
- Auth.js types and flows
- Drizzle schema
- P0 model selector UI
- P0 visibility sharing UI
- P0 image/sheet/code artifacts
- ProseMirror editor stack，除非手动富文本编辑进入 P0

参考项目是 UI 和交互模型参考，不是架构参考。

## 6. 我们的数据流

### 6.1 初始加载

```text
GET /api/workspaces
GET /api/workspaces/:workspaceId/threads
GET /api/threads/:threadId
GET /api/workspaces/:workspaceId/artifacts
GET /api/workspaces/:workspaceId/files
GET /api/workspaces/:workspaceId/sources
```

### 6.2 启动 Run

```text
POST /api/threads/:threadId/runs
  -> returns RunDTO
  -> UI subscribes to GET /api/runs/:runId/events
```

### 6.3 SSE Events

SSE 应该发送 durable business events，而不是 AI SDK model deltas。

Artifact UI 最小事件：

```text
snapshot
run_created
sandbox_ready
agent_started
agent_thinking
agent_message
tool_call_started
tool_call_completed
file_written
source_recorded
artifact_started
artifact_delta
artifact_created
artifact_updated
run_completed
run_failed
run_timeout
run_cancelled
run_waiting_for_input
done
ping
```

命名对齐后端协议（[agent-runtime-protocol.md](./agent-runtime-protocol.md) §7）：`workspace_ready` 改为更细粒度的 `sandbox_provisioning`/`sandbox_ready`/`runner_started`（这里用 `sandbox_ready` 作为 UI 最小事件的代表）；`model_step` 改为 `agent_thinking`/`agent_message`（[ADR-0020](./decisions/0020-agent-event-payload-schema-and-tool-retry.md)）；新增 `run_waiting_for_input`（[ADR-0019](./decisions/0019-waiting-for-input-state.md)）。

如果 P0 不做 artifact content streaming，可以先省略 `artifact_delta`，在 `artifact_created` 前显示 skeleton。

### 6.4 Artifact State

UI 维护一个类似 Vercel Chatbot `useArtifact` 的轻量本地 artifact state，但使用我们的命名：

```ts
type UIArtifact = {
  artifactId: string;
  title: string;
  kind: "text" | "code" | "sheet" | "image";
  content: string;
  status: "streaming" | "idle" | "saving";
  isVisible: boolean;
  boundingBox: {
    top: number;
    left: number;
    width: number;
    height: number;
  };
};
```

P0 可以用 Zustand 或 React Query。项目已经有 Zustand 和 React Query，不要为了照搬参考项目单独引 SWR。

推荐：

- React Query 管理 server data。
- Zustand 或小型 React context 管理当前可见 artifact panel。
- 当前 SSE hook 更新 React Query cache 和当前 artifact state。

## 7. 组件规划

建议组件树：

```text
src/components/app/AppShell.tsx
src/components/app/AppSidebar.tsx
src/components/app/WorkspaceGroup.tsx
src/components/app/ThreadGroup.tsx
src/components/app/UserNav.tsx

src/components/chat/Conversation.tsx
src/components/chat/MessageList.tsx
src/components/chat/MessageBubble.tsx
src/components/chat/RunEventList.tsx
src/components/chat/ToolEventCard.tsx
src/components/chat/Composer.tsx

src/components/artifacts/ArtifactPanel.tsx
src/components/artifacts/ArtifactPreview.tsx
src/components/artifacts/ArtifactToolCard.tsx
src/components/artifacts/ArtifactActions.tsx
src/components/artifacts/ArtifactVersionFooter.tsx
src/components/artifacts/renderers/TextArtifactRenderer.tsx

src/hooks/useArtifactPanel.ts
src/hooks/useWorkspaceState.ts
src/hooks/useThreadState.ts
src/hooks/useRunEvents.ts
```

P0 不要做嵌套卡片式 dashboard。App shell 本身就是产品主界面。

## 8. Artifact UI 需要的 API 契约补充

确认或新增这些 DTO：

```ts
type ArtifactKind = "text" | "code" | "sheet" | "image";

type ArtifactDTO = {
  id: string;
  workspaceId: string;
  threadId?: string;
  runId: string;
  title: string;
  kind: ArtifactKind;
  path?: string;
  contentSnapshot?: string;
  version: number;
  createdAt: string;
  updatedAt?: string;
};

type ArtifactVersionDTO = {
  id: string;
  artifactId: string;
  version: number;
  contentSnapshot?: string;
  createdAt: string;
};
```

Endpoints：

```text
GET /api/workspaces/:workspaceId/artifacts
GET /api/artifacts/:artifactId
GET /api/artifacts/:artifactId/versions
GET /api/artifacts/:artifactId/download
```

P1 可选：

```text
POST /api/artifacts/:artifactId/versions
POST /api/artifacts/:artifactId/restore
```

## 9. 前端 TDD 计划

坚持 API-first。API workflow 没闭环前，不做最终 UI。

### Phase UI-0：视觉基础

先写测试：

- component test renders `AppShell` with mocked user, workspaces, threads
- component test sidebar collapses and preserves active workspace/thread
- component test mobile shell does not overlap composer and sidebar

实现：

- 增加 reference design tokens
- 增加 sidebar primitives
- 增加 app shell
- 增加 user footer

验收：

- shell 可用 fake data 渲染
- 还不依赖 API

### Phase UI-1：Workspace Sidebar

先写测试：

- hook test loads workspace list
- component test shows workspace group
- component test shows thread group for active workspace
- component test creates new workspace through mocked mutation
- component test creates new thread through mocked mutation

实现：

- `AppSidebar`
- `WorkspaceGroup`
- `ThreadGroup`
- 接 workspace/thread APIs

验收：

- 左侧栏符合目标信息架构
- active state 由 URL 驱动

### Phase UI-2：Conversation And SSE

先写测试：

- hook test loads thread snapshot
- hook test merges SSE events into active run
- component test renders agent_thinking, agent_message, tool_call_started, tool_call_completed
- component test run completion stops active streaming state

实现：

- `useSessionState` 重构为 `useThreadState`
- `useRunSSE` 重构为 `useRunEvents`
- 按 Vercel Chatbot 风格渲染 conversation column

验收：

- API-created run 可通过 SSE 观察
- refresh 从 DB snapshot 恢复

### Phase UI-3：Artifact Preview

先写测试：

- component test renders artifact creation in timeline
- component test clicking preview opens artifact panel
- component test skeleton renders while artifact is streaming or loading

实现：

- `ArtifactPreview`
- `ArtifactToolCard`
- 把 `artifact_started`、`artifact_created`、`artifact_updated` 映射为 preview cards

验收：

- Artifact 作为可点击卡片显示在 conversation/timeline 中

### Phase UI-4：Artifact Panel

先写测试：

- hook test visible artifact state opens/closes
- component test desktop panel renders as right side panel
- component test mobile panel renders as fixed overlay
- component test copy/download actions
- component test version footer when versions exist

实现：

- `useArtifactPanel`
- `ArtifactPanel`
- `TextArtifactRenderer`
- `ArtifactActions`
- `ArtifactVersionFooter`

验收：

- artifact panel 交互形态接近 Vercel Chatbot
- 不使用 AI SDK `UseChatHelpers`
- 内容来自我们的 artifact API/SSE state

### Phase UI-5：完整流程

先写测试：

- mocked API integration test：
  - load workspace
  - open thread
  - start run
  - receive SSE artifact event
  - open artifact panel
- optional Playwright test with scripted runner mode

实现：

- app shell 接完整 APIs
- loading/error/empty states

验收：

- 前端可以不直连模型流，也跑完 research artifact happy path

## 10. 依赖计划

推荐新增：

```bash
pnpm add lucide-react sonner date-fns usehooks-ts motion
```

可选：

```bash
pnpm add streamdown @streamdown/cjk @streamdown/code @streamdown/math @streamdown/mermaid
pnpm add -D @tailwindcss/typography tailwindcss-animate
```

除非决定直接复制参考项目的 state model，否则避免新增 SWR。优先使用现有 React Query 和 Zustand。

CodeMirror、ProseMirror、react-data-grid、图片工具等，等对应 artifact kinds 进入 P1 再加。

## 11. 待决策问题

1. P0 artifact 内容要不要增量 streaming？
   - A：不 streaming。`artifact_created` 前显示 skeleton。
   - B：通过 `artifact_delta` events 实时更新。
   - 建议：先 A，等 ingest 和 artifact versions 稳定后再 B。

2. Artifact 手动编辑是否 P0？
   - A：只读 artifact，支持 copy/download。
   - B：可编辑 artifact，保存为新版本。
   - 建议：P0 只读，P1 可编辑。

3. Markdown 渲染是否使用 Streamdown？
   - A：plain markdown renderer 或 preformatted text。
   - B：Streamdown，支持 CJK/code/math。
   - 建议：如果可接受新增依赖，用 Streamdown；研究报告会受益。

4. Artifact panel state 使用 Zustand 还是只用 React Query cache？
   - 建议：Zustand 或小型 React context 管理可见性和 bounding box；React Query 管理持久化 artifact content。

## 12. 实现护栏

- 不要把 UI 耦合到 AI SDK message parts。
- 不要让 artifact 只是 chat bubble；它必须能打开为一等 panel。
- 不要让 artifact content 只依赖内存 SSE；必须能从 API 恢复。
- 不要混淆 workspace files 和 artifacts。
- 可用 workspace shell 优先，不要先做 landing page。
- 组件命名要对齐领域：workspace、thread、run、artifact。


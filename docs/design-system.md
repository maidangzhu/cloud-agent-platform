# 设计规范 — Research Workspace Agent

## 1. 目的

这份文档定义 Research Workspace Agent 前端的产品设计规则。

UI 应该像一个严肃的 workspace 产品：

- 安静
- 精确
- 足够紧凑，适合反复使用
- artifact-first
- 长时间 agent 执行时仍然可读
- 刷新、重连、run 状态变化时行为可预测

视觉参考是 Vercel Chatbot，但产品模型不同。我们的 UI 围绕 workspaces、threads、runs、files、sources、artifacts 和 usage 组织。

## 2. 产品原则

### 2.1 Workspace 优先于 Chat

界面必须让用户明确知道自己正在一个持久化 workspace 内工作。

Chat 只是一个交互表面。真正持久化的对象是：

- workspace
- thread
- run
- workspace file
- artifact
- source

### 2.2 Artifact 是交付物

Artifact UI 必须是一等能力。

Artifact 不只是 assistant message。它是稳定交付物，有 title、kind、version、content snapshot 和 source trail。

界面应该清晰展示 artifact：

- 正在创建时
- 创建完成时
- 被打开时
- 有版本历史时

### 2.3 Events 是审计，不是噪音

Agent events 的作用是帮助用户信任和调试 run，而不是占据整个工作区。

Events 使用紧凑、可扫描的行渲染：

- model step
- tool call
- file written
- source recorded
- artifact created
- run completed/failed/cancelled/timeout

### 2.4 两阶段机制深挖流程（Stage 1 / Stage 2）

见 [ADR-0013](./decisions/0013-mechanism-deep-dive-refinement.md)。核心交互不是一次性生成报告，是"报告 → 追问 → 深挖"的多轮对话：

- **Stage 1（广度概览）：** 用户给定一个闭源产品，agent 产出该产品有哪些开源平替、各自主打什么的概览 artifact。
- **用户选择：** 用户从概览中挑一个具体感兴趣的机制（如"反截屏怎么做的"）。这一步是 agent 主动停下来等待，对应 run 状态 `waiting_for_input`（见 [ADR-0019](./decisions/0019-waiting-for-input-state.md)，composer 规则见 §9.3）。
- **Stage 2（深度挖掘）：** agent 针对该机制去若干开源实现的源码里交叉验证，产出机制深挖 artifact（可能是新 artifact，也可能是同一 artifact 的新版本）。

UI 上，这体现为同一个 thread 内的连续 run：conversation 里能看到"概览完成 → 等待你选择 → 深挖中 → 深挖完成"的连续状态，不是两个割裂的功能入口。

### 2.5 API State 是事实源

UI 可以有 optimistic state，但刷新后必须始终能从 API snapshot 恢复。

不要让正确性依赖内存中的 SSE。

## 3. 信息架构

```text
App
  Auth Shell
    Login
    Register

  Workspace Shell
    Sidebar
      Account
      Workspace actions
      Workspace list
      Active workspace thread list

    Main
      Workspace / thread header
      Conversation
      Run timeline
      Composer

    Artifact Panel
      Preview
      Content
      Actions
      Versions
```

## 4. 布局

### 4.0 三栏主次关系（重要）

三栏不是平级面板，是主次关系：

```text
左 sidebar（workspace/thread 导航，低频操作）
中 conversation（主界面，唯一输入通道，永远在）
右 artifact panel（报告，默认隐藏，有内容才弹出/更新）
```

这不是"文档编辑器"产品（Notion 那种三栏平级），是"agent 干活、汇报结果"产品（Manus/Cursor 那种）。用户驱动 agent 的唯一方式是中间的 chat；artifact 是被动产出、被查看的东西，因此是右侧弹出的副面板，不常驻、不是编辑入口。

对应 Stage 1 / Stage 2 流程（见 2.4）：

1. 用户在中间 chat 发起调研请求，agent 跑完在 conversation 里回一条消息，带 artifact 预览卡片（概览报告）。
2. 用户点击预览卡片，右侧弹出 artifact panel，展示概览内容。
3. 用户回到中间 chat 继续提出想深挖的机制，进入下一个 run（可能经过 `waiting_for_input`）。
4. agent 深挖完成，右侧 panel 更新（新版本或新 artifact），conversation 同步一条消息。

sidebar 在这个流程中基本不参与——它只是"我有几个不同调研项目（workspace）"的容器，不是每次交互都碰的东西。

### 4.1 Desktop

Desktop layout：

```text
| sidebar | conversation | artifact panel |
```

规则：

- Sidebar 可折叠。
- Artifact panel 打开时，conversation 仍然保持可读。
- Artifact panel 从右侧打开。
- 宽屏下 artifact panel 宽度约 55-60% viewport。
- Artifact panel 关闭时，conversation 有舒适 max width。
- Composer 固定在 conversation 底部。

### 4.2 Mobile

Mobile layout：

```text
default: conversation
sidebar: sheet / overlay
artifact: full-screen overlay
```

规则：

- Artifact 以全屏 overlay 打开。
- Sidebar 以 mobile drawer 打开。
- Composer 不能被浏览器 safe area 挡住。
- 长 artifact 内容独立滚动，不影响 conversation。

### 4.3 Empty States

Empty state 应该紧凑且可操作。

使用：

- 短标题
- 一句说明
- 主操作按钮

避免：

- 营销文案
- 大 hero 区域
- 只有装饰插画的大空白

## 5. 视觉风格

### 5.1 调性

UI 应该中性、工作导向。

使用：

- neutral background
- subtle borders
- 克制的 hover states
- 小标签
- 紧凑分组导航

避免：

- 装饰性渐变
- 大营销卡片
- 彩色 dashboard
- dark-only experience
- app surface 里过大的标题

### 5.2 Color Tokens

使用 token-based colors，不要在组件里散落一次性 gray 值。

必需 tokens：

```css
--background
--foreground
--card
--card-foreground
--muted
--muted-foreground
--accent
--accent-foreground
--border
--input
--ring
--sidebar
--sidebar-foreground
--sidebar-accent
--sidebar-accent-foreground
--sidebar-border
--destructive
```

推荐语义 tokens：

```css
--success
--success-foreground
--warning
--warning-foreground
--info
--info-foreground
```

状态使用：

- running：neutral 或 info
- completed：success
- cancelling：warning
- cancelled：muted
- failed：destructive
- timeout：warning/destructive，取决于严重程度

### 5.3 Light 和 Dark

Light mode 是默认设计目标。

Dark mode 通过 tokens 支持，不要为组件写两套分支。

不要做 dark-only 界面。

### 5.4 Borders 和 Radius

规则：

- 用 border 表达结构。
- 优先使用 `1px` token border。
- controls 和 repeated items 使用 6-10px radius。
- 避免 nested cards。
- 避免把 page sections 做成 floating cards。

推荐 radius：

```text
small controls: 6px
buttons: 8px
panels: 10px
artifact preview: 12px max
```

### 5.5 Shadows

谨慎使用 shadows。

允许：

- artifact panel overlay shadow
- dropdown/menu shadow
- floating toolbar shadow

避免：

- 每个 card 都有 shadow
- 很重的 blur shadow
- 装饰性 glow

## 6. 排版

### 6.1 字体

使用 Next.js app font stack。

Mono font 用于：

- command output
- code
- ids
- file paths

### 6.2 字号

推荐 scale：

```text
sidebar labels: 10-11px uppercase or semibold
sidebar items: 13px
body text: 14px
message text: 14-15px
panel title: 14px semibold
section heading: 13px semibold
artifact content: 15-16px
code: 13px
```

规则：

- 不要用 viewport-scaled font sizes。
- 不要用 negative letter spacing。
- app headings 保持紧凑。
- 大号展示字体只用于 auth/onboarding，不用于 workspace surfaces。

## 7. 间距

基础节奏：

```text
4px micro gap
8px default gap
12px grouped item gap
16px panel padding
24px major section padding
```

规则：

- Sidebar rows 要紧凑。
- Conversation 内容要适合长阅读。
- Event rows 不要过高。
- Composer 尺寸变化不能导致周围布局跳动。

## 8. 图标

使用 `lucide-react` icons。

规则：

- 常见工具操作使用 icon-only buttons。
- Icon-only buttons 必须有 tooltip 或 accessible label。
- App chrome 图标尺寸保持 14-18px。
- Artifact kind 使用一致图标：
  - text/report：file text
  - code：code
  - sheet/table：table
  - image：image
  - source：link
  - file：file
  - command：terminal
  - run：activity/play

除非 lucide 没有需要的图标，否则不要手写 custom SVG。

## 9. App Shell

### 9.1 Sidebar

Sidebar sections：

```text
Header
  logo / collapse
  new workspace
  new thread

Account
  user

Workspaces
  workspace list

Threads
  active workspace threads

Footer
  settings / logout
```

规则：

- Active workspace 和 active thread 必须视觉上区分清楚。
- Workspace group 和 thread group 不能混在一起。
- 删除 workspace/thread 必须二次确认。
- Collapsed sidebar 保留关键 action icons。

### 9.2 Header

Header 显示：

- workspace title
- thread title
- active run state if any
- connection state only when relevant

保持紧凑，不要重复 sidebar navigation。

### 9.3 Composer

Composer 规则（[ADR-0019](./decisions/0019-waiting-for-input-state.md) 修订——旧规则"有 active run 时禁用 submit"会堵死 Stage1→Stage2 的唯一用户入口，已废弃）：

- 固定底部。
- 支持多行输入。
- Enter 提交，Shift+Enter 换行。
- 按 `derivedUiState` 精确区分 submit 是否启用：

  ```text
  idle / running / possibly_running / cancelling
    → 禁用 submit（agent 在干活或收尾中）

  waiting_for_input
    → 启用 submit（这正是用户的回答入口）
    → placeholder 换成引导性文案（如"回答 agent 的问题…"）
    → composer 上方显示提示条，展示 run.waitingForInput 的 question/options

  completed / failed / timeout / cancelled / interrupted
    → 启用 submit（run 已结束，用户可以开始新一轮）
  ```

- 这个判断逻辑必须写成共享 hook `useComposerEnabled(run: RunDTO)`，桌面端和移动端共用同一份条件，不允许各端各写一份。
- active run（`running`/`possibly_running`/`cancelling`）时显示 cancel；`waiting_for_input` 时不显示 cancel（sandbox 已退出，没有可取消的执行）。
- connection/running state 必须清楚。

不要在 app 内放长说明文案，placeholder 足够。

## 10. Conversation

### 10.1 Message Rendering

User messages：

- 右对齐或视觉区分。
- 紧凑 bubble 或 plain block。
- 保留换行。

Assistant messages：

- 左对齐或 full-width readable block。
- 支持 markdown。
- 不能和 artifacts 混淆。

### 10.2 Run Timeline

Timeline 渲染在触发 run 的 user prompt 下方。

Event groups：

- preparation
- model reasoning/summary step
- tools
- files
- sources
- artifacts
- terminal state

规则：

- Terminal state 始终可见。
- Tool calls 可以展开。
- 长 command output 截断，并提供展开入口。
- 错误要清晰，但不要视觉爆炸。

### 10.3 Connection State

只在 active runs 显示连接状态：

- live
- reconnecting
- polling
- interrupted

没有 active run 时不要常驻 connection badge。

## 11. Artifact System

### 11.1 Artifact Preview

Artifact preview 出现在 conversation/timeline 内。

Preview 包含：

- kind icon
- title
- status
- content snippet 或 skeleton
- version if available

交互：

- 点击打开 artifact panel。
- preview 捕获 bounding box，用于打开动画。
- loading state 使用 skeleton，不要只有 spinner。

### 11.2 Artifact Panel

Panel 包含：

```text
Header
  close
  title
  updated/generated state
  version badge

Content
  renderer by artifact kind

Toolbar
  copy
  download
  version history
  request polish / follow-up

Footer
  version navigation when viewing older version
```

Desktop：

- right-side panel
- border-left
- independent scroll

Mobile：

- fixed full-screen overlay
- own header
- own scroll

### 11.3 Artifact Kinds

P0：

- `text`

P1：

- `code`
- `sheet`
- `image`

Text artifact content 应该支持 markdown rendering。

### 11.4 Versions

P0 version behavior：

- 默认打开 latest version。
- 如果存在 versions，支持 previous/next navigation。
- copy/download 当前查看版本。

P1：

- diff
- restore
- manual edit and save as new version

### 11.5 Artifact 和 File 区分

Workspace file UI：

- file path
- size
- updated time
- latest run
- content preview if text

Artifact UI：

- title
- kind
- version
- source references
- created by run
- user-facing content snapshot

不要把所有 workspace files 都叫 artifacts。

## 12. Files 和 Sources

### 12.1 Files Panel

Files panel 是 artifacts 的辅助表面。

显示：

- path
- kind
- size
- updated time
- latest run

操作：

- open
- copy path
- download if supported

### 12.2 Sources Panel

Sources 应该能从 artifacts 和 runs 追踪。

显示：

- title
- URL/path/command
- kind
- run
- timestamp

Source rows 应紧凑且可链接。

## 13. Usage（原 Credits，[ADR-0015](./decisions/0015-usage-telemetry-and-ops-priorities.md) 改为用量遥测）

不再是"额度/余额"模型——没有 balance、没有"额度不足拒绝启动"。用量信息是给自己复盘用的观测数据，UI 优先级明显降低，不需要常驻 badge。

显示（可以放在一个不常驻的 details 面板，如 workspace 设置或 run detail 里）：

- 本次 run 花了多少 token（`totalTokens`）
- 走的哪个 provider/model
- 首字节延迟 / 总耗时（`ttfbMs`/`durationMs`）

不需要：

- current balance badge（不存在这个概念）
- low balance state
- insufficient credits error（不存在这个错误路径）

默认 UI 不显示 raw token accounting，除非用户打开 details。

## 14. 状态

### 14.1 Loading

使用 skeletons：

- sidebar lists
- message history
- artifact preview
- artifact panel content

使用 spinners：

- 短按钮操作
- panel header generating indicator

### 14.2 Empty

Empty state 文案短：

```text
No workspaces yet.
Create a workspace to start researching.
```

### 14.3 Error

Error 应包含：

- 失败了什么
- 可行时提供 retry action
- 失败后的稳定状态

不要在 UI 里倾倒 stack traces。

### 14.4 Offline / Interrupted

Active run：

- 显示 reconnecting/polling state。
- 保留 last known events。
- 允许 manual refresh。

Terminal run：

- 不继续显示 connection state。

## 15. Accessibility

要求：

- 所有 icon buttons 有 accessible labels 或 tooltips。
- sidebar、composer、artifact panel 支持键盘导航。
- mobile artifact overlay 打开时 focus 进入 overlay。
- Escape 关闭 artifact panel 或 modal。
- 颜色不能作为唯一状态提示。
- 文本对比度满足 WCAG AA。
- destructive actions 需要确认。

## 16. Motion

Motion 用于：

- artifact panel open/close
- sidebar collapse
- events 轻量出现动画

规则：

- duration 保持在 150-300ms。
- 支持 prefers-reduced-motion。
- 避免持续装饰动画。
- loading skeleton pulse 可接受。

## 17. 响应式规则

Breakpoints：

```text
mobile: < 768px
tablet: 768-1023px
desktop: >= 1024px
wide: >= 1440px
```

规则：

- mobile artifact panel 是 full-screen。
- desktop artifact panel 是 side-by-side。
- tablet 上 sidebar 可以 collapse。
- 除 code blocks/tables 外，内容不应横向滚动。
- composer 始终可触达。

## 18. 文案

语气：

- 简洁
- 直接
- 产品导向

术语保持一致：

- Workspace
- Thread
- Run
- Artifact
- File
- Source
- Usage（用量遥测，不再叫 Credits，见 [ADR-0015](./decisions/0015-usage-telemetry-and-ops-priorities.md)）

避免：

- 用 “chat” 指代整个产品
- 用 “document” 指代我们的 artifact domain
- app 内长解释说明
- 用户可见文案暴露后端内部术语

## 19. 组件命名

使用领域命名：

```text
AppShell
AppSidebar
WorkspaceList
ThreadList
Conversation
MessageList
RunTimeline
ToolEventCard
ArtifactPreview
ArtifactPanel
ArtifactActions
ArtifactVersionFooter
FilesPanel
SourcesPanel
UsageDetails
```

避免从参考项目复制但不符合我们领域的名字：

- `Document`
- `ChatHistory`
- `UseChatHelpers`

## 20. 测试要求

所有有状态 UI 组件都应该先有测试再实现。

必需测试组：

- app shell render
- sidebar workspace/thread active state
- composer submit/cancel
- run SSE merge
- artifact preview click
- artifact panel desktop/mobile rendering
- artifact version footer
- usage details rendering
- error and loading states

UI tests mock API data。E2E tests 可以使用 fake runner mode。

## 21. Design Review Checklist

合并 UI 变更前检查：

- [ ] 屏幕是否清楚表达 workspace/thread context？
- [ ] Artifacts 是否和 assistant messages 视觉区分清楚？
- [ ] Artifact 刷新后是否能重新打开？
- [ ] Files 和 artifacts 在 UI 上是否是两个不同概念？
- [ ] Active run state 是否能经受 SSE reconnect？
- [ ] 布局是否同时适配 mobile 和 desktop？
- [ ] Icon-only buttons 是否有 label？
- [ ] Destructive actions 是否需要确认？
- [ ] 文本是否不重叠、不溢出？
- [ ] App 内是否避免了 marketing-style hero sections？
- [ ] 实现是否使用 API/SSE state，而不是 AI SDK browser state？


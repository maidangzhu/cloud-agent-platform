# PRD — Personal Task Workspace Agent

## 1. 产品定义

Personal Task Workspace Agent 是一个云端个人任务助理工作区。

它不是用户的“分身”，不替用户做最终判断，也不自动代表用户对外行动。它是一个在授权边界内工作的助理：理解用户的偏好、工作方式和任务目标，在隔离 sandbox 中搜索资料、阅读内容、整理信息、修改文件，并产出可审计的 artifact。

一句话：

> 用户创建一个 task workspace，把任务交给 agent；agent 在云端 sandbox 里执行搜索、读写文件、运行命令和整理内容，最后生成报告、草稿、计划或代码改动等 artifact，并把过程完整同步回浏览器。

## 2. 为什么做

普通聊天机器人只给回答，但很多真实任务需要一个持续工作区：

- 需要搜索和阅读多份资料
- 需要保存中间 notes
- 需要生成结构化报告或草稿
- 需要修改文件或代码
- 需要看到 agent 做了什么
- 需要在卡住时取消
- 需要下次接着同一个任务继续做

这个产品的核心不是“聊天”，而是“任务执行 + workspace 沉淀 + artifact 交付”。

## 3. 用户

P0 面向个人高级用户，尤其是开发者、独立创作者、产品/技术从业者。

典型用户诉求：

- 我想让 agent 帮我研究一个主题，并生成报告
- 我想让 agent 帮我整理资料，输出面试讲解稿
- 我想让 agent 帮我阅读代码或文档，生成修改建议
- 我想让 agent 在一个隔离环境里安全执行命令
- 我想看到它每一步干了什么，而不是只看到最终回答

P0 不面向企业协作场景，不做完整多租户、SSO、RBAC、多人实时协作。

## 4. 和 OpenClaw 的区别

OpenClaw 更像 personal assistant gateway：接入 WhatsApp、Telegram、邮件、日历等个人渠道，通过 skills 帮用户操作现有应用。

本产品不是这个方向。

本产品聚焦 cloud task workspace：

| 维度 | OpenClaw 类产品 | 本产品 |
|---|---|---|
| 主场景 | 多渠道个人自动化 | 明确任务的 workspace 执行 |
| 入口 | chat app / gateway | browser workspace |
| 核心能力 | app integrations / skills | sandbox execution / artifact workflow |
| 输出 | 执行动作、回复消息、处理日程 | 报告、草稿、计划、notes、代码或文档改动 |
| 安全重点 | 第三方账号权限 | sandbox 隔离、事件审计、取消和超时 |
| 用户关系 | 像生活/工作管家 | 像任务助理 |

定位边界：

- 不替用户发邮件、发消息、提交外部动作
- 不接管用户账号
- 不做“AI clone”
- 高风险动作必须产出草稿或请求确认

## 5. 核心对象

### 5.1 Assistant Profile

用户的工作偏好和边界。

P0 可以先内置或用配置文件表示，例如：

- 语言偏好：中文，简明直接
- 工作方式：先方案、再代码
- 交付偏好：分阶段、可验证
- 风险边界：不自动对外发送、不删除文件、不执行高危命令
- 输出偏好：报告要结构化，区分事实、推断和建议

### 5.2 Workspace

一个具体任务或项目的工作台。

P0 workspace 包含：

- task prompt
- notes
- sources
- artifacts
- run history
- sandbox handle

### 5.3 Run

一次 agent 执行。

一个 workspace 可以有多个 run，例如：

1. “研究 OpenClaw 和本项目的区别”
2. “把报告改成面试讲解稿”
3. “补充 sandbox 架构 tradeoff”

### 5.4 Artifact

agent 产出的可交付物。

例子：

- `research-report.md`
- `interview-script.md`
- `architecture-review.md`
- `implementation-plan.md`
- `code-change-summary.md`

Artifact 是产品价值的主要承载物，不是聊天气泡。

### 5.5 Source

研究或分析中引用的来源。

例子：

- 网页
- 文档
- GitHub repo
- 本地 workspace 文件
- 命令输出

P0 要求 artifact 可以关联 source，至少能说明“这个结论来自哪里”。

### 5.6 Approval

高风险动作前的确认。

P0 可以先只做策略约束，不做完整 UI 审批流。规则是：

- 可以生成草稿
- 可以写 workspace 文件
- 可以运行低风险命令
- 不可以自动对外发送
- 不可以删除大量文件
- 不可以执行明显危险命令

## 6. P0 用户故事

### Story 1：创建任务 workspace

用户打开网页，输入一个任务：

> “帮我研究 OpenClaw 和我的 Personal Task Workspace Agent 有什么区别，生成一份产品定位报告。”

系统创建 workspace 和 run。

验收：

- workspace 被创建
- run 进入执行状态
- UI 能看到任务标题和运行状态

### Story 2：agent 在 sandbox 中执行

agent 在 sandbox 内执行任务，而不是在主服务进程里直接跑。

它可以：

- 搜索或读取网页
- 读取 workspace 文件
- 写 notes
- 生成 artifact
- 必要时运行安全命令

验收：

- agent loop 运行在 sandbox
- control plane 不把 DB/Redis 凭证下发给 sandbox
- sandbox 只能通过 scoped run token 上报事件

### Story 3：生成 artifact 报告

agent 最终生成一个 markdown artifact，例如：

`openclaw-comparison-report.md`

报告包含：

- 任务摘要
- 关键发现
- 对比表
- 建议定位
- sources

验收：

- artifact 可在 UI 打开
- artifact 存在于 workspace
- artifact 能关联 sources 或执行证据

### Story 4：展示执行过程

用户能看到 agent 的执行轨迹。

事件包括：

- run started
- search started/completed
- page fetched
- file read/written
- artifact created
- run completed/failed/cancelled

验收：

- UI 通过 SSE 或轮询展示事件
- 刷新页面后能从数据库恢复历史事件

### Story 5：取消和超时

用户可以取消正在运行的任务。系统也要防止 LLM、网络或 sandbox 卡死导致 run 永远挂住。

验收：

- 用户点击 cancel 后，run 在 1s 左右进入 `cancelled`
- LLM 首响应超时会 retry 或 fail fast
- run 超过最大时长后进入 `timeout`
- orphan run 可以被 sweep 收敛

### Story 6：workspace 继续追问

用户可以在同一个 workspace 继续追问：

> “把报告改成 3 分钟面试口述版。”

agent 能看到已有 artifact、notes 和 run history，并生成新的 artifact 或修改现有 artifact。

验收：

- 同 workspace 的后续 run 可以读取已有文件/artifact
- warm sandbox 可复用时优先复用

## 7. P0 功能范围

P0 必做：

- 单用户 workspace
- 创建 run
- sandbox 内执行 agent
- 基础工具：search/fetch/read_file/write_file/list_files/run_command
- event stream
- artifact 生成和展示
- source 记录
- cancel
- timeout
- warm sandbox 复用

P0 不做：

- 企业多租户
- SSO / SAML
- 多人协作
- 复杂 RBAC
- skills marketplace
- agent 自动对外发消息或发邮件
- embedding 检索
- 完整 memory proposal 流
- freeze/thaw OSS 快照
- 计费

## 8. P1 / P2

P1：

- Assistant Profile UI
- Approval UI
- 更完整的 source citation
- artifact diff / version history
- workspace import/export
- 更稳定的 web browsing
- freeze/thaw

P2：

- 多用户共享 workspace
- org / team
- skill proposal
- long-term memory
- embedding search
- integrations with email/calendar/chat

## 9. 非功能需求

| 项 | P0 目标 |
|---|---|
| cancel 响应 | 1s 左右进入取消流程 |
| run 最大时长 | 默认 30min，可配置 |
| event 延迟 | UI 侧 1s 内可见 |
| artifact 可恢复 | 刷新后仍可从数据库/文件恢复 |
| sandbox 权限 | 无 DB/Redis 凭证 |
| workspace 复用 | 同 workspace 后续 run 优先复用 warm sandbox |
| 高风险命令 | 默认拒绝 |

## 10. 面试讲法

可以这样介绍：

> 我做的是一个 Personal Task Workspace Agent。它不是聊天机器人，也不是替我操作所有账号的 AI 分身，而是一个云端任务助理。用户把一个明确任务放进 workspace，agent 在隔离 sandbox 里搜索、读文件、跑命令、写报告，并把完整执行轨迹、sources 和 artifact 同步回浏览器。核心技术点是 agent-in-sandbox、run lifecycle、event ingest、artifact workflow、cancel/timeout 和 workspace 复用。


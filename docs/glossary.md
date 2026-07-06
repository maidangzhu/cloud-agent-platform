# 术语表 — Research Workspace Agent

这份术语表是产品、后端、前端、测试和 AI coding 共同使用的语言标准。

代码、API、数据库表、测试和 UI 文案都应该尽量使用这里定义的名字。

## 核心术语

### User

由 Better Auth 管理的已认证账号。

规则：

- User 拥有 workspace。
- User 只能访问自己拥有或未来被授权访问的资源。
- 不要把 Better Auth 的 session 当成业务对话对象。

### Auth Session

由 Better Auth 管理的登录会话。

规则：

- Auth Session 不是 research thread。
- Auth session 表由 Better Auth 管理。
- 应用代码应该通过 auth helper 读取当前用户，不要手动解析 auth 表。

### Workspace

用户拥有的长期研究工作区。

例子：

- “AI coding agent 市场研究”
- “OpenClaw 对比分析”
- “代码仓库分析”

Workspace 拥有：

- threads
- runs
- messages
- workspace files
- artifacts
- sources
- sandbox state

规则：

- Workspace 是顶层业务边界。
- 每个 thread、run、file、artifact、source 都必须属于一个 workspace。
- 除非未来明确支持协作，否则跨 workspace 访问一律拒绝。

### Thread

Workspace 里的一个对话线或任务线。

规则：

- Thread 替代旧版业务里的 `Session`。
- Thread 属于一个 workspace。
- Thread 包含 messages 和 runs。
- Thread 是用户可见对象，显示在左侧栏当前 workspace 下。

避免：

- 不要把业务对话对象命名为 `Session`。

### Message

Thread 里的用户消息或 assistant 消息。

规则：

- User message 通常触发一个 run。
- Assistant message 是对话输出。
- Assistant message 不是 artifact。
- Message 属于 workspace 和 thread。

### Run

用户 prompt 触发的一次 sandbox agent 执行。

规则：

- Run 属于一个 user、workspace 和 thread。
- Run 有状态机，包含非终态的 `waiting_for_input`（agent 主动停下等用户选择，见 ADR-0019）。
- Run 产生 events、tool calls、file changes、sources、artifacts 和 LLMUsageRecord。
- Run 的终态不可覆盖；所有状态转移走条件原子 UPDATE，禁止 check-then-act（见 ADR-0018）。

### Agent Event

Run 执行过程中的 append-only 审计事件。

例子：

- `run_created`
- `sandbox_ready`
- `agent_started`
- `agent_thinking` / `agent_message`（取代旧的 `model_step`，见 ADR-0020）
- `tool_call_started`
- `tool_call_completed`
- `file_written`
- `source_recorded`
- `artifact_created` / `artifact_updated`
- `run_completed`
- `run_waiting_for_input`（见 ADR-0019）

规则：

- Event 是审计事实。
- Event 在同一个 run 内有单调递增的 `seq`。
- 页面刷新后必须可以从数据库恢复 event。
- Event 通过 Control Plane 写入，sandbox 不能直接写 DB。

### Tool Call

Sandbox agent 调用工具时产生的持久化记录。

例子：

- `web_search`（经 Control Plane search proxy 代理，见 ADR-0020）
- `fetch_url`（sandbox 直接发起，带 SSRF guard，见 ADR-0020）
- `read_file`
- `write_file`
- `run_command`
- `create_artifact`
- `record_source`

规则：

- Tool call 绑定到一个 run。
- Tool call 有 args、status（含 `rejected`，用于 policy 拦截/SSRF guard 触发）、result、error 和时间戳。
- Tool output 可能因为 UI 和 LLM 上下文安全被截断。

### Workspace File

Workspace 文件系统里的文件，通常由 sandbox agent 创建或修改。

例子：

- `notes/raw-search-results.md`
- `sources/openclaw-homepage.html`
- `drafts/report-outline.md`
- `repos/project/README.md`

规则：

- Workspace file 是工作材料。
- Workspace file 可以是临时文件，也可以被覆盖。
- Workspace file 不会自动成为正式交付物。
- Workspace file 的元数据需要入库。
- 小文本内容可以存数据库；大文件或二进制文件应该进对象存储。

### Artifact

Run 产出的正式用户交付物。

例子：

- 研究报告
- 对比表
- 面试讲稿
- 实施计划
- 代码审查总结

规则：

- Artifact 是主要产品输出。
- Artifact 必须通过 `create_artifact` 显式创建。
- Artifact 可以引用 workspace file path。
- Artifact 必须保存 content snapshot 或 storage key，保证可恢复。
- Artifact 有 title、kind、version、run 和 source trail。
- Artifact 不等于 assistant message，也不等于 workspace file。

### Artifact Version

Artifact 的版本化快照。

规则：

- 默认打开最新版本。
- 历史版本仍然可读。
- P0 如果只支持单版本，可以先直接用 Artifact.version 表示。
- P1 应该支持独立的 `ArtifactVersion`。

### Source

研究过程中使用的证据来源。

例子：

- URL
- 抓取的网页
- 本地 workspace 文件
- 命令输出
- 搜索结果

规则：

- Source 属于 workspace。
- Source 可以属于 run。
- Source 可以被 artifact 引用。
- Source 用来解释结论来自哪里。

### Sandbox

运行 agent runtime 和工具的隔离执行环境。

规则：

- Agent loop 在 sandbox 内运行。
- Sandbox 可以读写 workspace 文件系统。
- Sandbox 没有数据库凭证。
- Sandbox 没有 Better Auth session。
- Sandbox 使用 scoped run token 调用 ingest 和 LLM proxy。

### Sandbox Runner

在 sandbox 内启动的进程或脚本，负责执行 agent loop。

职责：

- 加载 run config
- 执行 agent loop
- 执行工具
- heartbeat
- ingest events
- ingest files
- ingest artifacts
- ingest sources
- 处理 cancel 和 timeout 信号

### Control Plane

可信的服务端应用。物理上是 `apps/api`（Hono，见 ADR-0022），不再是 Next.js 内嵌 API routes；`apps/web`（Next.js）只做前端 UI。

职责：

- auth（Better Auth，挂在 apps/api）
- workspace/thread/run API
- sandbox orchestration
- scoped run token
- ingest verification
- LLM proxy / search proxy
- 用量遥测（LLMUsageRecord）
- SSE（含 Redis Streams 转发，见 ADR-0021）
- persistence

### Ingest API

Sandbox runner 用来向 Control Plane 上报持久化事实的 API。

规则：

- 需要 scoped run token。
- 校验 run/workspace/thread/user 绑定关系。
- 幂等写入。
- 除明确允许的终态幂等记录外，终态 run 拒绝继续写入。

### Scoped Run Token

Control Plane 为单个 run 签发的短期凭证。

绑定到：

- userId
- workspaceId
- threadId
- runId
- expiration
- allowed scopes

规则：

- 不能用于其他 run。
- 不能访问其他用户资源。
- 不能超过过期时间继续使用。
- run 终态后应可撤销或失效。

### LLM Proxy

Control Plane 提供的 LLM 代理端点，让 sandbox 不需要拿长期 provider key 就能调用模型。

规则：

- 需要 scoped run token。
- 检查 run 状态。
- 记录 usage（LLMUsageRecord）。
- 向 sandbox 返回或流式返回模型输出。
- 归一化 `finish_reason` 等语义边界信号，供攒批落库判断（见 ADR-0009/0017）。

### Search Proxy（新增，见 ADR-0020）

Control Plane 提供的 search 代理端点，让 sandbox 不需要拿 search provider key（如 Exa）就能搜索。

规则：

- 需要 scoped run token。
- 5xx 重试 2 次，4xx 不重试。
- 记录 usage。

### LLM Usage Record（原 Credit/Credit Ledger，已废弃旧概念，见 ADR-0015）

append-only 的 LLM/search 调用用量记录，纯观测，不产生"拒绝执行"的业务后果。不再有"点数"概念——本项目单人使用，没有额度耗尽拒绝启动 run 的真实场景。

字段包括 provider、model、token 用量、首字节延迟、总耗时，纯粹用于自己复盘。

## 避免使用的术语

### Session

不要用于业务对话对象。

原因：

- Better Auth 使用 auth session。
- 业务对话线使用 `Thread`。

### Document

除非在说外部文档，否则不要作为产品对象名。

原因：

- Vercel Chatbot 使用 `Document`。
- 我们的正式交付物叫 `Artifact`。

### Chat

不要作为整个产品的总称。

原因：

- 产品是 workspace agent，不只是聊天应用。
- 根据场景使用 `Thread`、`Conversation` 或 `Message`。

## 打磨过程新增术语

以下术语来自设计打磨（ADR）过程。带 P1 标记的为未来能力，P0 不实现，但需在模型/协议预留扩展位。

### Memory（P1）

跨 workspace/thread 持久化的关键事实（用户决策、偏好、复用信息）。agent 可在 run 内加载相关 memory 作为上下文。区别于 Thread message（单线对话）和 Artifact（交付物）。见 ADR-0002。

### Skill（P1）

可按需加载的能力包：一段指令 + 可选工具/资源。agent 判断相关时才拉入上下文，以节省 token 并复用能力（如"深度调研""代码审查"）。区别于 Tool（始终可用的原子操作）。见 ADR-0002。

### Working Copy（工作副本）

沙箱文件系统里 agent 干活用的那份文件。它是**易失缓存**，不是事实源；持久的家在 Control Plane（DB + 对象存储）。见 ADR-0003。

### 三层文件模型

- **沙箱临时文件**：`run_command` 顺手产生，沙箱回收即没（快照可留作加速），不可见。
- **WorkspaceFile**：经 `write_file`/ingest 显式登记，持久、文件面板可见。
- **Artifact**：经 `create_artifact` 提升，快照可恢复、一等交付物。

见 ADR-0003。

### Phase（heartbeat 阶段）

heartbeat 携带的当前活动标识（如 `waiting_llm` / `running_tool:fetch_url`），用于区分"死等 / 死循环 / 进程已死"。见 ADR-0007。

### Sweep

定时触发的兜底裁判，扫描 heartbeat 过期的非终态 run 并强制收敛到终态，保证"绝不永久 running"。Vercel 上由 Cron 触发。见 ADR-0008。

### 防腐层（Anti-Corruption Layer）

隔离外部不稳定性与协议差异的一层。本项目指 LLM Proxy：把 provider 选择、fallback、retry、fail-fast 超时、reasoning 字段归一都收敛于此，让业务层面对统一稳定接口。见 ADR-0009。

### AG-UI

Agent-User Interaction Protocol，CopilotKit 推的开放前端协议，走 SSE、事件驱动、双向。本项目用它作为"前端 ↔ Control Plane"的通信标准；沙箱侧仍用自己的 ingest。见 ADR-0010。

### 双通道（token 流 vs 业务事实）

- **token 流**（思考/说话）：可重放可丢，低延迟直通、异步落聚合段。
- **业务事实**（tool/file/artifact/终态）：必须持久，先落库再广播。

"一切先落库"原则仅约束业务事实。见 ADR-0011。

### waiting_for_input（主交互路径，已定，见 ADR-0019）

human-in-the-loop 下 agent 停下来等用户输入时的 run 状态。非终态、非活跃执行的第三类"合理挂起"，sweep 用超长超时（默认 7 天）兜底。不做"resume 同一个 run"——sandbox 进程正常退出，用户回答通过创建新 run 处理（复用 `POST /api/threads/:threadId/runs`）。原为边缘兜底设计，因"机制深挖"两阶段交互模型（见 Stage 1/Stage 2）成为主路径地基。见 ADR-0013、ADR-0019。

### 条件原子 UPDATE（Atomic Conditional Update）

所有状态变更统一改为"一条 SQL 同时表达检查条件和执行变更"，用受影响行数判断转移是否生效，禁止应用层"先查再改"两步式 check-then-act 逻辑。覆盖 Run.status 转移、workspace 归档检查+创建 run、SandboxInstance 复用互斥三处。见 ADR-0018。

### currentRunId（SandboxInstance 字段）

标记当前占用某个 SandboxInstance 的 run id，`NULL` 表示空闲可复用。认领动作走条件原子 UPDATE，防止并发请求抢到同一个沙箱。见 ADR-0018。

### Stream Chunk / Redis Streams + cursor

token 逐字转发的独立通道，走 `POST /api/ingest/stream-chunk` → Redis `XADD`，不落库。SSE 消费方用 entry ID 当 cursor 续读（`Last-Event-ID` 对应上次收到的 cursor），解决建连竞态和重连丢字问题。见 ADR-0016、ADR-0021。

### Alternative（平替）

某个热门闭源产品（如 Manus）对应的开源替代实现（如 OpenManus）。本项目的主打场景是调研目标产品与其平替，产出带 source 的技术方案对比报告，区别于泛化的"技术选型调研"。见 ADR-0012。

### 机制深挖（Mechanism Deep-Dive）

用户带着一个具体机制疑问（如"Cluely 怎么做到投屏不被录进去"）而非泛泛的"有没有平替"进来，agent 深入若干开源平替的源码，交叉验证该机制的具体实现方式。是本项目相对于"GitHub 搜索 + listicle"聚合信息的核心增量所在——聚合页能回答"有哪些平替"，答不了"怎么做到的"。见 ADR-0013。

### Stage 1 / Stage 2（两阶段交互）

机制深挖的两段式流程：Stage 1 产出广度概览（该产品有哪些开源平替、各自主打什么），用户从中挑一个感兴趣的具体机制；Stage 2 才针对该机制去 3+ 个开源实现的源码里交叉验证。不是一次性生成报告，是"报告 → 追问 → 深挖"的多轮对话。见 ADR-0013。

# ADR-0005：Workspace 概念 + Agent in Sandbox（达阵方案）

- 状态：已采纳
- 日期：2026-06-28
- 取代：暂无（与 ADR-0001「Sandbox as Tool」**并存**，形成两层范式）
- 相关：ADR-0001（sandbox-as-tool）、ADR-0002（multi-turn session）、ADR-0003（event 存储）、ADR-0004（前端状态）、[`architecture.md`](../architecture.md)

## 背景

之前的设计（ADR-0001）把 session 与 sandbox 1:1 绑定，每次 run 起一个 sandbox 跑完即扔。但用户的新需求迫使我们重新思考：

- **企业级 workspace**：一家公司有多个 team member，他们要**协作**同一个 workspace，看同一份文件、改同一份文件
- **chat → artifact**：右侧栏是 chat，中间是 preview（被 chat 改出来的 markdown 笔记 / artifact），左侧是文件树
- **agent 真的跑在沙箱里**：面试官一致反馈「生产级都是这么做的」，范式 A（sandbox as tool）只够做原型，agent 自己要进 microVM

## 决定

### 1. Workspace 是一等公民（不再 1:1 Session）

```
Workspace (1) ──┬── (N) WorkspaceMember (user × role)
                ├── (N) WorkspaceFile    (path × version × contentRef)
                ├── (N) EditCheckpoint   (rollback unit, agent 写之前落)
                ├── (N) Skill            (workspace-scoped: instructions, tools, RBAC)
                ├── (N) WorkspaceEvent   (universal event schema)
                └── (1) Sandbox          (singleton per workspace, may hibernate)
```

`Session` 退化为 workspace 下的一个「聊天话题」（"thread"），agent 跑出来改的是 workspace 文件，不直接绑 session。

### 2. Sandbox 与 Workspace 是 1:1 长期关系（不再 1:1 Run）

- 第一次有 run 在 workspace 上 → 起 sandbox（Vercel microVM）
- 后续 run 复用同一个 sandbox（warm 状态，文件持久化）
- N 分钟无活动 → sandbox 冻结，状态写 OSS
- 下一个 run 触发 → 冷启动从 OSS 拉回 workspace 文件

### 3. Agent 真的跑在沙箱里（范式 B）

```
Workspace Server (Next.js + Neon)
   │
   │ HTTP API + WebSocket
   ▼
[ Vercel microVM ]
   ├─ /opt/agent-server/daemon.cjs     ← Fastify HTTP+WS（PoC 已实现）
   │    ├─ /api/health
   │    ├─ /api/files    GET/POST/DELETE
   │    ├─ /api/exec     POST
   │    └─ /api/events   WebSocket (file watcher)
   │
   ├─ Pi Agent (via run-agent)        ← LLM 推理 + 工具调用 + 状态机
   │    └─ tools: write_file/read_file/list_files/exec
   │         └─ 全走 daemon HTTP
   │
   └─ /workspace  ← 挂载 workspace 文件
       ├─ README.md
       ├─ notes/
       └─ ...
```

**关键约束**：
- agent loop 的**持久化状态**（transcript、event、checkpoint）**留在 server**（Neon Postgres），沙箱只装**执行态**（workspace 文件 + daemon + agent 进程）
- sandbox 冷启动时只需要拉 workspace 文件 + 重启 daemon + 重启 agent，**不重建 transcript**

### 4. Workspace 文件存储

**冷启动优化版的存储分层**：

| 层 | 内容 | 存储 | 何时落 |
|----|------|------|--------|
| Working set | 当前 sandbox 内活动文件 | sandbox FS（`/workspace`） | 实时 |
| Warm snapshot | sandbox 冻结时的 tar | OSS / S3 兼容存储 | 冻结时 |
| Cold storage | 全部历史 + checkpoint | Neon Postgres（`WorkspaceFile.contentRef`） | 每次 edit |
| Asset files | 大二进制（图片/PDF） | OSS | 写时 |

**冷启动**：`sandbox.fs.readdir(/workspace)` 缺失 → 从 OSS 拉 warm snapshot 解压 → daemon 启动 → 健康。

**为什么不直接 FUSE 挂 OSS？**
- 每次 syscall 跨网络，agent tool loop 一次 read+write+exec 触发数十次 syscall → 性能差
- agent 通常在短时间内（一次 run）只动少数文件，文件快照更高效

### 5. Agent → Daemon 协议（已 PoC 验证）

`/api/agent-server/[key]/...` 暴露：
- `POST /api/agent-server` 启 sandbox
- `GET  /api/agent-server` 列表 handle
- `DELETE /api/agent-server?key=...` 停
- `GET  /api/agent-server/[key]/files` 树
- `GET/POST /api/agent-server/[key]/files/[...path]` 读写
- `POST /api/agent-server/[key]/exec` shell
- `POST /api/agent-server/agent` Pi Agent + sandbox tools 端到端

PoC 已经在真 Vercel microVM 里跑通（2026-06-28 验证）：
- 启 sandbox 50s（冷启 + npm install fastify + daemon 启动）
- LLM 调工具读写文件 89s（单次 run）
- 重用 sandbox 0 启动 + LLM 22s
- 端到端：用户说"读 diary.md 加一行" → 沙箱里 diary.md 真多了那行

### 6. UI 三栏布局

```
┌─ Workspace (Notion-like) ─────┬─ Preview / Editor ─────────┬─ Chat ──────────┐
│ 📁 workspace/                 │ diary.md                    │  User: 追加一行  │
│  ├─ 📄 README.md              │ ─────────────────────────   │                  │
│  ├─ 📁 notes/                 │ deployed agent-in-sandbox   │  Assistant: ...  │
│  │   └─ 📄 today.md           │ 2026-06-28                  │                  │
│  └─ 📄 diary.md (current) ⭐  │ second run ok               │  [tool] read_file│
│                               │                             │  [tool] write_file│
│  + New file                   │                             │                  │
└───────────────────────────────┴─────────────────────────────┴──────────────────┘
```

- 左：tree（用 daemon 的 `/api/files` + WebSocket 实时刷新）
- 中：preview（只读 markdown 渲染 → 下一步可编辑，绑 `EditCheckpoint`）
- 右：chat（沿用 ADR-0003 的 event stream）

## 为什么不抄 PilotDeck / OpenHands

| 维度 | PilotDeck | OpenHands | 我们 |
|------|-----------|-----------|------|
| 协议 | AGPL-3.0（传染） | Apache-2.0 | 内部 |
| 沙箱 | K8s 容器池 | Docker / E2B / Modal / Runloop | Vercel microVM |
| Workspace | 项目级（嵌 git） | `BaseWorkspace` 抽象 | 协作级（多 user） |
| Agent | 多 agent 协作（MoE） | 单 agent + SDK | Pi Agent（已有） |
| 借鉴 | git 集成、模板 | workspace 抽象、event schema | |
| 不抄 | license、K8s 池 | 整套 SDK | |

OpenHands 的 `BaseWorkspace` 抽象值得学：把"workspace 是什么"从 agent 抽离，让 agent 协议层不绑具体存储。我们以后也定义 `WorkspaceDriver` interface（`readFile/writeFile/listFiles/exec`），后端可以是 sandbox / 本地 / OSS 镜像。

## 关键不变量

1. **沙箱是 stateless 的执行环境**——sandbox 死了，state 都在 Neon + OSS 里
2. **transcript 永远不落沙箱**——它跟 run 走，不跟 workspace 走
3. **多用户并发 edit 同一文件** —— 用 `EditCheckpoint`（乐观锁）+ ETag/mtime 对比；如果冲突，落 `WorkspaceEvent.conflict`，UI 给用户合并
4. **跨 workspace 隔离** —— 沙箱启动时只挂自己 workspace 的目录，不能 `cd ../`

## 实施路线

1. ✅ **Phase 1: protocol PoC**（已完成 2026-06-28）
   - daemon.cjs（1.6MB bundle） + orchestrator + 三栏 UI + agent 端到端
2. **Phase 2: 持久化**（接下来）
   - `Workspace` / `WorkspaceFile` / `EditCheckpoint` / `WorkspaceEvent` 加到 schema
   - 内存 registry → DB-backed registry
   - handle 重启后能从 DB 找到对应 sandbox 并复用
3. **Phase 3: 协作**
   - 多人同 workspace → WS broadcast
   - conflict 解决 UI
4. **Phase 4: 冷启动 / 冻结**
   - sandbox 闲置 N 分钟 → 冻结（写 OSS snapshot）
   - 下次 run → 解冻 + 拉文件
5. **Phase 5: Skill / 工具市场**
   - workspace-scoped skills（团队定制的工具集 + 指令）

## 风险

- **Vercel microVM 冷启动 ~30s** —— 用户首 run 等 30s 体验差，用 warm pool + 预装 daemon 镜像缓解
- **OSS 同步延迟** —— 文件 watcher 跟 WS broadcast 的最终一致性
- **agent 跨 workspace 资源越权** —— sandbox 内执行要严格 `chroot` 到 workspace 目录，禁 `cd ..`
- **协议分裂** —— v0.2 protocol PoC 已定（fastify HTTP+WS），但以后可能换成 gRPC，得留 abstraction

## 参考项目（按价值排序）

1. **OpenHands** `software-agent-sdk`（78.5k★）—— `BaseWorkspace` 抽象、universal event schema、agent server 协议
2. **Vercel Open Agents** `vercel-labs/open-agents`（5.7k★）—— 同构，sandbox+git，sibling project
3. **OpenBMB PilotDeck** `OpenBMB/PilotDeck`（3.7k★）—— agent MoE、git 集成、模板（仅借鉴，license 不可用）
4. **sandbox-agent** `rivet-dev/sandbox-agent`（1.45k★）—— universal agent API（multi-provider 抽象）
5. **Vercel Chatbot** `vercel/chatbot`（20.5k★）—— Document/Artifact 模式、UI 范式
6. **hermes-workspace** `outsourc-e/hermes-workspace`（5.87k★）—— workspace 作为控制面板


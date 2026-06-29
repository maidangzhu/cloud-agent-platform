# 系统架构 — Cloud Workspace

> **范式**：Cloud Workspace + Agent-in-Sandbox + Workspace-scoped Memory/Skills
> **信任边界**：sandbox 边缘
> **事实源**：Postgres（Neon）
> **取代**：archived 旧版 `architecture.md`

## 1. 顶层架构图

```
┌────────────────────────────────────────────────────────────────────┐
│ Browser                                                           │
│ ┌─────────┬──────────┬──────────┐                                 │
│ │ FileTree│ Preview  │ Chat     │   ← React + TanStack Query       │
│ │ 左 240  │ 中 flex  │ 右 400   │   ← fetch + EventSource (SSE)   │
│ └────┬────┴────┬─────┴────┬─────┘                                 │
└──────┼─────────┼──────────┼────────────────────────────────────────┘
       │ SSE     │ fetch    │ POST + SSE
       ▼         ▼          ▼
┌────────────────────────────────────────────────────────────────────┐
│ Control Plane (Next.js + Neon Postgres + Redis)                    │
│                                                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ Auth / RBAC  │  │ Workspace    │  │ Ingest API   │              │
│  │ (JWT + Perm) │  │ Registry     │  │ /events/     │              │
│  │              │  │ (DB-backed)  │  │  ingest      │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ Event Bus    │  │ Asset        │  │ SSE Fanout   │              │
│  │ (Redis pub/  │  │ Catalog      │  │ (UI pub/sub) │              │
│  │  sub)        │  │ (Mem/Skill)  │  │              │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
└──────┬──────────────────────────────────────┬───────────────────────┘
       │ scoped run token + manifest          │ scoped run token
       ▼                                      ▼
┌──────────────────────────────────────────┐ ┌──────────────────────┐
│ Cloud Sandbox A (Vercel microVM)          │ │ Cloud Sandbox B      │
│   /workspace/                             │ │ (Vercel microVM)     │
│     files/                                │ │                      │
│     .agent/                               │ │                      │
│       session.sqlite  ← Runtime WAL      │ │                      │
│       outbox.sqlite   ← Outbox           │ │                      │
│     .skills/        ← 物化 skill          │ │                      │
│     .memory/        ← memory cache        │ │                      │
│                                          │ │                      │
│   agent-daemon.cjs (Fastify+WS)          │ │                      │
│   Pi Agent loop (本地)                    │ │                      │
│   forwarder (POST /events/ingest)        │ │                      │
│   ❌ 无 Postgres 凭证                     │ │                      │
│   ❌ 无 Redis 凭证                        │ │                      │
│   ✓ 只有 scoped run token                │ │                      │
└──────────────────────────────────────────┘ └──────────────────────┘
       │              │
       └──────┬───────┘
              │  freeze: tar.gz → OSS
              │  thaw:   ← OSS
              ▼
        ┌──────────┐
        │ OSS / S3 │
        └──────────┘
```

## 2. 5 层架构

### L1 — Browser（客户端）

| 栏 | 组件 | 数据源 |
|---|---|---|
| 左 | `FileTree` | `WS /api/workspace/:id/events?type=file.*` |
| 中 | `FilePreview` | `GET /api/workspace/:id/files/:path`（带 ETag） |
| 右 | `Chat` | `POST /api/workspace/:id/runs` + `SSE /api/runs/:id/stream` |

**客户端只调 control plane，不直接连 sandbox**。

### L2 — Control Plane（编排 + 资产 + 状态）

职责：
- 鉴权 / 权限（JWT + WorkspaceMember）
- Workspace 生命周期（创建 / 邀请 / 冻结元数据）
- Sandbox 调度（warm / freeze / thaw / pool）
- Run 编排（启动 / 取消 / 状态机）
- 事件摄取（POST /events/ingest，幂等写）
- SSE 推送（事件 → 浏览器）
- Memory / Skill 审批

代码组织：

```
src/app/api/                                ← Next.js Route Handlers
  workspace/
    [id]/
      route.ts                              ← workspace 元数据
      files/[...path]/route.ts              ← 文件读 / 写
      members/route.ts                      ← 协作者
      runs/route.ts                         ← 启动 run
      events/route.ts                       ← SSE: workspace event 流
  runs/
    [runId]/
      route.ts                              ← run 状态
      stream/route.ts                       ← SSE: 单 run event 流
      cancel/route.ts
  events/
    ingest/route.ts                         ← sandbox → control plane
  agent-server/                             ← PoC 旧路径，新版用上面

src/server/
  workspace/                                ← Workspace 业务逻辑
    registry.ts                             ← sandbox 调度
    permissions.ts
  agent/
    run-agent.ts                            ← run 编排（编排逻辑，不含 loop）
    llm-fallback.ts                         ← 跨 channel 降级
    llm-retry.ts                            ← 单 channel 重试
    model.ts                                ← resolveModelChain
  sync/
    outbox-protocol.ts                      ← event schema, ingest 验签
  sandbox/
    provider.ts                             ← SandboxProvider interface
    vercel.ts                               ← Vercel 实现
    local.ts                                ← dev 实现
  memory/
    catalog.ts
    proposal.ts
  skill/
    catalog.ts
    proposal.ts
    materialize.ts                          ← 推 skill 到 sandbox
```

### L3 — Sandbox Provider 抽象

```typescript
// src/server/sandbox/provider.ts
export interface SandboxProvider {
  name: "vercel" | "local" | "e2b";
  createOrResume(name: string): Promise<SandboxHandle>;
  isAlive(handle: SandboxHandle): Promise<boolean>;
}

export interface SandboxHandle {
  providerName: string;
  externalId: string;                  // Vercel sandbox name
  baseUrl: string;                      // https://sb-xxx.vercel.run
  // 内部 API（不直接暴露给业务）
  runCommand(cmd: string, args?: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  writeFiles(files: { path: string; content: string | Buffer }[]): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  stop(): Promise<void>;
}
```

### L4 — Agent Runtime（sandbox 内）

sandbox 内 3 类进程：

1. **agent-daemon** — Fastify HTTP+WS，暴露：
   - `GET /api/health`
   - `GET /api/files?path&depth`
   - `GET/POST/DELETE /api/files/*`
   - `POST /api/exec`
   - `WS /api/events`（file watcher）
   - `POST /api/internal/skills/:name`（control plane 推 skill 物化）
2. **Pi Agent loop** — LLM 推理 + 工具调用循环，工具全走 agent-daemon HTTP
3. **forwarder** — 守护进程，扫 outbox，POST 到 control plane ingest API

```
agent loop
  → 本地事务 (sqlite)
       INSERT INTO session (seq, role, content, ts)
       INSERT INTO outbox  (seq, event_id, type, payload)
  → COMMIT
  → forwarder.poll() → POST /api/events/ingest → UPDATE outbox SET acked=1
```

### L5 — Storage 层

| 数据 | 存储 | 写入方 | 读出方 |
|---|---|---|---|
| Workspace / Org / User / Member | Postgres | control plane | control plane |
| WorkspaceFile | Postgres + sandbox FS | control plane + sandbox | 双方 |
| EditCheckpoint | Postgres | control plane | control plane |
| Run / Run status | Postgres | control plane | control plane |
| AgentEvent | Postgres | ingest API only | control plane + UI |
| ToolCall | Postgres | ingest API only | control plane + UI |
| Memory | Postgres | ingest API only | control plane + sandbox |
| Skill | Postgres | ingest API only | control plane + sandbox |
| Memory cache | sandbox FS | sandbox | sandbox |
| Skill 物化 | sandbox FS | control plane 推 | sandbox |
| Session WAL | sandbox sqlite | sandbox | sandbox |
| Outbox | sandbox sqlite | sandbox | sandbox |
| Warm snapshot | OSS | sandbox tar → OSS | OSS → sandbox 解压 |

**核心原则**：Postgres 是事实源；sandbox 内的所有数据都是它的镜像 + 缓存。

## 3. 关键数据流

### 3.1 启动一个 Run

```
1. UI: POST /api/workspace/:id/runs  { prompt, session_id? }
2. Control plane:
   a. 鉴权 (workspace_member role ≥ editor)
   b. SELECT workspace.sandbox 状态
      - warm → 复用
      - frozen → thaw（30s）
      - 无 → provision（50s）
   c. 签发 scoped run token (TTL = run duration)
   d. 写 runs 表 (status=created)
   e. PUT scoped token + run manifest 到 sandbox
3. Sandbox:
   a. agent-daemon 接收 manifest
   b. 启动 Pi Agent loop
   c. 加载 /workspace/.skills/* + /workspace/.memory/*
   d. 开始处理 prompt
4. Agent loop:
   a. 调 LLM
   b. 收到 tool_call
   c. 调 agent-daemon HTTP 写文件
   d. 写 local sqlite (session + outbox)
   e. forwarder 上报 ingest
5. Control plane ingest:
   a. 验 token
   b. ON CONFLICT DO NOTHING 写 agent_events
   c. UPDATE runs.last_acked_seq
   d. 推 Redis pub/sub
6. SSE fanout:
   a. 浏览器 EventSource 收到事件
   b. React state 更新
7. Agent 结束：
   a. 写 event: run_completed
   b. 触发 sweep 在 30min 后 freeze sandbox
```

### 3.2 Sandbox Freeze

```
1. Cron (5min 一次):
   SELECT workspaces WHERE last_activity_at < now() - 30min AND sandbox_status='warm'
2. 调 freeze(workspace_id):
   a. UPDATE workspace_sandboxes SET status='freezing'
   b. Sandbox: pkill -TERM agent, 等 5s, SIGKILL
   c. Sandbox: forwarder.flush_all() 等所有 outbox acked
   d. Sandbox: tar czf /tmp/snap.tar.gz /workspace
   e. Sandbox: PUT OSS (via control plane 间接调 OSS API)
   f. Control plane: UPDATE workspace_sandboxes SET status='frozen', warm_snapshot_url=...
   g. sandbox.stop()
```

### 3.3 Sandbox Thaw

```
1. get_or_create_sandbox(workspace_id):
   row.status = 'frozen'
2. UPDATE workspace_sandboxes SET status='thawing'
3. Provider.createOrResume(name) — Vercel 起新 sandbox（同名 getOrCreate）
4. 拉 OSS snapshot → 解压到 /workspace
5. 启动 agent-daemon
6. 启动 forwarder，offset=last_acked_seq
7. UPDATE workspace_sandboxes SET status='warm', base_url=...
```

## 4. 5 个核心抽象

| 抽象 | 解决的问题 | 变化频率 | 详见 |
|---|---|---|---|
| `SandboxProvider` | 多云沙箱适配 | 半年 | ADR-0003 |
| `WorkspaceDriver` | agent 框架适配 | 一年 | (P1 设计) |
| `OutboxEvent` | 状态同步 | 几乎不变 | ADR-0002 |
| `EditCheckpoint` | 协作冲突 | 几乎不变 | (P0 设计) |
| `Memory / Skill` | 团队资产 | 经常加新 | ADR-0004 |

## 5. 关键不变量

1. **Postgres 是事实源** — 任何 UI 看到的"事实"必须能从 Postgres 读出
2. **Sandbox 不可信** — 不下发 DB/Redis 凭证，不下发长期 API key
3. **所有状态变化先成 event** — agent 内部变更必须先写 outbox
4. **DB 单一写入路径** — 只有 ingest API 能写 event log 类表
5. **transcript 同步不阻塞 run** — sandbox 内 sqlite 持久，DB 是镜像
6. **Token 短命** — scoped run token TTL = run duration
7. **超时兜底** — 任何 run 30min 内必有终态（Layer 3 + Layer 4）

## 6. 部署

```
                         ┌─────────────────────┐
                         │  Cloudflare CDN     │
                         │  (静态资源)          │
                         └──────────┬──────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────┐
│ Vercel (Next.js)                                   │
│   - Route Handlers (Node.js runtime)               │
│   - Edge Runtime for SSE                           │
│   - ISR for workspace page                         │
└────────────────┬───────────────────────────────────┘
                 │
       ┌─────────┼─────────┐
       ▼         ▼         ▼
   ┌──────┐ ┌──────┐  ┌────────┐
   │Neon  │ │Redis │  │OSS/S3  │
   │Postgres│ │(pub/ │  │(snap-  │
   │      │ │sub)  │  │ shots) │
   └──────┘ └──────┘  └────────┘

Sandbox: Vercel microVM (按需)
```

## 7. 旧架构变化对照

| 旧 | 新 | 原因 |
|---|---|---|
| agent loop 在 server | agent loop 在 sandbox | 信任边界、协作 |
| Session = 1:1 Sandbox | Session ⊂ Workspace, Workspace = 1:1 Sandbox | 协作 + 复用 |
| transcript 在 DB 单源 | transcript sandbox sqlite + DB 镜像 | 边界 + 恢复 |
| fire-and-forget HTTP | outbox + ingest + ack | 状态同步正确性 |
| Skill 是 prompt 字符串 | Skill 是版本化资产 + 物化 | 团队资产 |
| Memory 没有 | Memory 是版本化资产 + proposal | 团队记忆 |
| Sandbox 信任 sandbox | sandbox 不可信，scoped token | 安全 |
| 文件双写 | 文件单写（DB）+ sandbox 是镜像 | 不变量 |

详见 [docs/archive/architecture-pre-2026-06-28.md](archive/)（如果存在）。

## 8. ADR 索引

按依赖顺序：

1. [ADR-0001](adr/0001-trust-boundary-and-agent-in-sandbox.md) 信任边界 + Agent-in-Sandbox
2. [ADR-0002](adr/0002-outbox-sync-protocol.md) Outbox 同步协议
3. [ADR-0003](adr/0003-workspace-sandbox-lifecycle.md) Sandbox 生命周期
4. [ADR-0004](adr/0004-workspace-memory-and-skill.md) Memory / Skill
5. [ADR-0005](adr/0005-ui-three-pane-and-realtime.md) UI 三栏 + 实时
6. [ADR-0006](adr/0006-multi-tenant-and-permission.md) 多租户与权限
7. [ADR-0007](adr/0007-run-cancel-and-timeout.md) 取消 / 超时 / 孤儿回收

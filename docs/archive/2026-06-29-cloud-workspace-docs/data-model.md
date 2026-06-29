# 数据模型 — Cloud Workspace

> **事实源**：Postgres（Neon）
> **Sandbox 端**：本地 sqlite（WAL / outbox / session）—— 是镜像，不是事实源
> **取代**：archived 旧版 `data-model.md`

## 1. ER 总览

```
                    ┌────────┐
                    │  Org   │
                    └───┬────┘
                        │ 1:N
        ┌───────────────┼───────────────┐
        ▼                               ▼
   ┌─────────┐                    ┌──────────┐
   │  User   │                    │Workspace │
   └────┬────┘                    └────┬─────┘
        │ N:M (OrgMember)              │ 1:N
        │                              │
        │ N:M (WorkspaceMember)        ├──── Session ── Run
        └──────────────┬───────────────┤
                       │              ├──── WorkspaceFile
                       │              ├──── EditCheckpoint
                       │              ├──── MemoryEntry
                       │              ├──── Skill
                       │              ├──── WorkspaceSandbox
                       │              └──── WorkspaceEvent
                       ▼
                   (auth flow)
```

## 2. Schema（Postgres）

### 2.1 租户 / 身份

```sql
CREATE TABLE orgs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'free',   -- free/pro/enterprise
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  name        TEXT,
  avatar_url  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE org_members (
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,                  -- owner/admin/member
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id),
  name        TEXT NOT NULL,
  slug        TEXT,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);
CREATE INDEX ON workspaces (org_id, updated_at DESC);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,                 -- owner/editor/viewer
  invited_by   TEXT REFERENCES users(id),
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX ON workspace_members (user_id);
```

### 2.2 Workspace 资产

```sql
-- 文件元数据
CREATE TABLE workspace_files (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,                -- 相对 /workspace 路径
  content_hash  TEXT NOT NULL,                -- sha256
  size          BIGINT NOT NULL,
  mtime         TIMESTAMPTZ NOT NULL,
  -- 大文件：内容在 OSS，这里存 ref
  content_ref   TEXT,                         -- OSS key, null=小文件/DB BLOB
  content_blob  BYTEA,                        -- 小文件内联，> 1MB 走 OSS
  -- 协作锁
  locked_by     TEXT REFERENCES users(id),    -- 软锁：editor 打开时设置
  locked_at     TIMESTAMPTZ,
  -- 写入追踪
  last_writer   TEXT NOT NULL,                -- "user:uuid" | "agent:runId"
  last_run_id   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, path)
);
CREATE INDEX ON workspace_files (workspace_id, updated_at DESC);

-- 编辑 checkpoint（乐观锁 + 可回滚）
CREATE TABLE edit_checkpoints (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  path          TEXT NOT NULL,
  agent_run_id  TEXT,
  user_id       TEXT REFERENCES users(id),
  before_hash   TEXT NOT NULL,
  after_hash    TEXT,                         -- null = agent 还在改
  before_ref    TEXT,                         -- OSS 旧内容
  after_ref     TEXT,                         -- OSS 新内容
  reason        TEXT,                         -- agent 写时的说明
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON edit_checkpoints (workspace_id, path, created_at DESC);
```

### 2.3 Sandbox 调度

```sql
CREATE TABLE workspace_sandboxes (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
  provider          TEXT NOT NULL,            -- vercel/local/e2b
  provider_handle   TEXT,                     -- sandbox name
  base_url          TEXT,
  status            TEXT NOT NULL,            -- provisioning/warm/freezing/frozen/thawing/dead
  last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  warm_snapshot_url TEXT,                     -- OSS key
  outbox_offset     INTEGER NOT NULL DEFAULT 0,
  metadata          JSONB,                    -- 启动参数、version 等
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, provider)
);
CREATE INDEX ON workspace_sandboxes (status, last_activity_at);
```

### 2.4 Session / Run

```sql
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  title         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON sessions (workspace_id, updated_at DESC);

CREATE TABLE runs (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES sessions(id),
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id),
  user_id            TEXT NOT NULL REFERENCES users(id),
  status             TEXT NOT NULL,            -- 状态机，见 ADR-0007
  user_prompt        TEXT NOT NULL,
  agent_system_prompt TEXT,
  last_acked_seq     INTEGER NOT NULL DEFAULT 0,
  max_steps          INTEGER NOT NULL DEFAULT 30,
  max_duration_ms    INTEGER NOT NULL DEFAULT 1800000,
  started_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  last_heartbeat_at  TIMESTAMPTZ,
  error              TEXT,
  metadata           JSONB,                    -- model、tools、skill_ids 等
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON runs (workspace_id, created_at DESC);
CREATE INDEX ON runs (session_id, created_at DESC);
CREATE INDEX ON runs (status, last_heartbeat_at)
  WHERE status NOT IN ('completed','failed','timeout','cancelled','interrupted');
```

### 2.5 Event Log（事实源 — 单一写入点：ingest API）

```sql
CREATE TABLE agent_events (
  id            TEXT PRIMARY KEY,              -- event_id = run_id:seq
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  session_id    TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  type          TEXT NOT NULL,                 -- tool_call.started / message.delta / run.started / run.completed / ...
  actor         TEXT NOT NULL,                 -- "user:uuid" | "agent:runId" | "system"
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);
CREATE INDEX ON agent_events (workspace_id, seq);
CREATE INDEX ON agent_events (run_id, seq);
CREATE INDEX ON agent_events (type, created_at DESC);

-- 工具调用专用索引（按工具查）
CREATE TABLE tool_calls (
  id            TEXT PRIMARY KEY,              -- 同 agent_events.id
  run_id        TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  args          JSONB,
  result        JSONB,
  status        TEXT NOT NULL,                 -- started/completed/failed/blocked
  started_at    TIMESTAMPTZ NOT NULL,
  completed_at  TIMESTAMPTZ
);
CREATE INDEX ON tool_calls (workspace_id, started_at DESC);
CREATE INDEX ON tool_calls (run_id);
```

### 2.6 Memory 资产

```sql
CREATE TABLE memory_entries (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL,               -- workspace/session/user/org
  owner_id        TEXT,                        -- user/org 级别时填
  content         TEXT NOT NULL,
  source_event_id TEXT,                        -- 哪个 event 提取的
  confidence      REAL NOT NULL DEFAULT 1.0,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'active',  -- active/proposed/superseded/deleted
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON memory_entries (workspace_id, scope, status);
CREATE INDEX ON memory_entries USING gin (tags);

CREATE TABLE memory_revisions (
  id               TEXT PRIMARY KEY,
  memory_id        TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
  content          TEXT NOT NULL,
  prev_revision_id TEXT,
  edit_reason      TEXT,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON memory_revisions (memory_id, created_at);

CREATE TABLE memory_proposals (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  proposed_content  TEXT NOT NULL,
  proposed_scope    TEXT NOT NULL,
  proposed_tags     TEXT[],
  source_event_id   TEXT,
  reasoning         TEXT,
  confidence        REAL,
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending/approved/rejected
  reviewed_by       TEXT,
  reviewed_at       TIMESTAMPTZ,
  review_note       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON memory_proposals (workspace_id, status, created_at DESC);

-- P1: 向量检索
CREATE TABLE memory_embeddings (
  memory_id   TEXT PRIMARY KEY REFERENCES memory_entries(id) ON DELETE CASCADE,
  embedding   VECTOR(1536),
  model       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2.7 Skill 资产

```sql
CREATE TABLE skills (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT REFERENCES workspaces(id) ON DELETE CASCADE,  -- null=全局
  name          TEXT NOT NULL,
  version       TEXT NOT NULL DEFAULT '1.0.0',
  source        TEXT NOT NULL,                -- builtin/team/agent-generated
  manifest      JSONB NOT NULL,               -- { description, instructions, tools, trigger, requiredRole }
  enabled       BOOLEAN NOT NULL DEFAULT true,
  status        TEXT NOT NULL DEFAULT 'active',  -- active/proposed/deprecated
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name, version)
);
CREATE INDEX ON skills (workspace_id, status, enabled);

CREATE TABLE skill_proposals (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  name              TEXT NOT NULL,
  proposed_manifest JSONB NOT NULL,
  reasoning         TEXT,
  source_events     TEXT[],                    -- 哪些 run 触发的提议
  status            TEXT NOT NULL DEFAULT 'pending',
  reviewed_by       TEXT,
  reviewed_at       TIMESTAMPTZ,
  review_note       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2.8 Proposal 通知

```sql
CREATE TABLE notifications (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  workspace_id  TEXT REFERENCES workspaces(id),
  type          TEXT NOT NULL,                -- memory.proposed / skill.proposed / mention / run.completed
  payload       JSONB NOT NULL,
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON notifications (user_id, read_at, created_at DESC);
```

## 3. Sandbox 端 Schema（SQLite）

`/workspace/.agent/session.sqlite` 和 `outbox.sqlite`（可分文件或合一）：

```sql
-- session WAL
CREATE TABLE messages (
  seq       INTEGER PRIMARY KEY,
  role      TEXT NOT NULL,                    -- user/assistant/tool/system
  content   TEXT NOT NULL,                    -- JSON
  ts        INTEGER NOT NULL
);

CREATE TABLE tool_calls (
  seq            INTEGER PRIMARY KEY,
  tool_call_id   TEXT NOT NULL,
  name           TEXT NOT NULL,
  args           TEXT,                        -- JSON
  result         TEXT,                        -- JSON
  status         TEXT NOT NULL,               -- started/completed/failed/blocked
  started_at     INTEGER NOT NULL,
  completed_at   INTEGER
);

CREATE TABLE plan_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                         -- JSON
);

CREATE TABLE pending_approvals (
  seq     INTEGER PRIMARY KEY,
  kind    TEXT NOT NULL,                      -- skill_install / memory_write / file_delete
  payload TEXT NOT NULL,                      -- JSON
  ts      INTEGER NOT NULL
);

-- outbox
CREATE TABLE events_outbox (
  seq         INTEGER NOT NULL,
  event_id    TEXT NOT NULL,                  -- run_id:seq
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,                  -- JSON
  acked       INTEGER NOT NULL DEFAULT 0,     -- 0/1
  acked_at    INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
) WITHOUT ROWID;

CREATE INDEX idx_outbox_acked ON events_outbox (acked, seq);

-- 全局 run 状态（forwarder 也要）
CREATE TABLE run_meta (
  run_id           TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  scoped_token     TEXT NOT NULL,
  token_exp_at     INTEGER NOT NULL,
  started_at       INTEGER NOT NULL,
  last_acked_seq   INTEGER NOT NULL DEFAULT 0
);
```

## 4. 数据写入路径总表

| 表 | 写入方 | 触发 |
|---|---|---|
| `orgs`, `users`, `org_members` | control plane | 注册 / admin |
| `workspaces`, `workspace_members` | control plane | UI |
| `workspace_files` | control plane (via UI) + ingest (via agent event) | 编辑 / 工具调用 |
| `edit_checkpoints` | control plane | 写文件前 |
| `workspace_sandboxes` | control plane | sandbox 调度 |
| `sessions`, `runs` | control plane | UI 启动 run |
| `runs.status` | control plane | 状态机转移 |
| `runs.last_acked_seq` | ingest API | forwarder 上报 |
| `agent_events` | **只有 ingest API** | sandbox 上报 |
| `tool_calls` | **只有 ingest API** | sandbox 上报 |
| `memory_entries` | control plane | proposal 审批通过 |
| `memory_proposals` | ingest API | agent 提议 |
| `skills` | control plane | proposal 审批通过 / 内置 |
| `skill_proposals` | ingest API | agent 提议 |
| `notifications` | control plane | proposal 创建 / mention |
| (sandbox) `session.sqlite` | sandbox | agent loop |
| (sandbox) `outbox.sqlite` | sandbox | agent loop |
| (sandbox) `/workspace/.memory/` | control plane 推 + sandbox 写 | 启动 / 变更 |
| (sandbox) `/workspace/.skills/` | control plane 推 | skill install |
| (OSS) `warm_snapshot` | sandbox tar → OSS | freeze |

## 5. 关键不变量（DB 层）

1. **`agent_events.id` 唯一** = 重试幂等
2. **`(run_id, seq)` 唯一** = sandbox 不能伪造 seq
3. **`runs.status` 转移合法** = 状态机校验
4. **`runs.last_heartbeat_at` 5s 更新一次** = sweep 兜底
5. **`workspace_sandboxes.status` ∈ {provisioning, warm, freezing, frozen, thawing, dead}** = 调度正确
6. **跨 org 查询一律 404** = 不泄露存在性
7. **sandbox 凭证只有 scoped run token** = 即使 sandbox 沦陷不能写 DB
8. **Memory / Skill status ∈ {proposed, active, deprecated}** = agent 不可直接 install

## 6. 旧 schema 变化

| 旧 | 新 | 原因 |
|---|---|---|
| `Run` 1:1 `Session` 1:1 `Workspace` | `Workspace` 1:N `Session` 1:N `Run` | 协作 |
| 无 `Org` | 有 `Org` | 多租户 |
| 无 `WorkspaceMember` 角色 | owner/editor/viewer | 协作 |
| `Sandbox` 每次新建 | `WorkspaceSandbox` 长期复用 | warm pool |
| 无 `Outbox` 表 | 内存 outbox.sqlite | ADR-0002 |
| 无 `Memory` | `MemoryEntry` + `MemoryRevision` + `MemoryProposal` | 团队记忆 |
| 无 `Skill` | `Skill` + `SkillProposal` | 团队工具 |
| `Event` 各种类型 | `AgentEvent` 统一 | universal event |
| 无 `EditCheckpoint` | 有 | 协作冲突 |


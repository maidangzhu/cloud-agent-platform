# API 契约 — Cloud Workspace

> **信任边界**：所有 API 接受两种 token
> - **User JWT**（浏览器用）— 身份 + 权限
> - **Scoped Run Token**（sandbox 用）— 受限的 run-scoped 权限
>
> **取代**：archived 旧版 `api-contract.md`

## 1. 鉴权

### 1.1 User JWT

```
POST /api/auth/login
Body: { email, password? } 或 OAuth callback
Response: { token, user }
```

JWT claims:
```json
{
  "iss": "control-plane",
  "sub": "user_uuid",
  "org_id": "org_uuid",
  "email": "alice@example.com",
  "exp": 1234567890
}
```

Header:
```
Authorization: Bearer <user_jwt>
```

### 1.2 Scoped Run Token（sandbox 用）

sandbox **没有** user JWT。control plane 启动 run 时签发：

```json
{
  "iss": "control-plane",
  "sub": "sandbox:<sandbox_id>",
  "scope": "run",
  "workspace_id": "ws_123",
  "run_id": "run_456",
  "permissions": [
    "events:ingest",
    "files:read:workspace",
    "files:write:workspace",
    "exec:workspace"
  ],
  "exp": 1234567890,
  "jti": "unique-id"
}
```

**永远不在 permissions 里**：
- `db:write:any`
- `sandbox:create` / `sandbox:stop` / `sandbox:list`
- `cross:workspace:read` / `cross:workspace:write`
- `user:*`（user 管理）

sandbox 用此 token 调 ingest API、agent-daemon 内部 API（不调 control plane 其他端点）。

## 2. API 端点

### 2.1 Auth

```
POST /api/auth/login
  body: { email, password }
  resp: { token, user: { id, email, name, avatar_url } }
```

```
POST /api/auth/register
  body: { email, password, name }
  resp: { token, user, org }
  side: 自动建 personal org
```

```
GET /api/auth/me
  auth: user JWT
  resp: { user, orgs: [{ id, name, role }] }
```

### 2.2 Workspace

```
GET /api/orgs/:orgId/workspaces
  auth: user JWT (org member)
  resp: { workspaces: [{ id, name, slug, role, updated_at, members_count }] }
```

```
POST /api/orgs/:orgId/workspaces
  auth: user JWT (org member)
  body: { name, slug }
  resp: { workspace }
  side: 自动把 creator 加为 workspace_member(role=owner)
```

```
GET /api/workspaces/:id
  auth: user JWT (workspace member)
  resp: { workspace, my_role, member_count, sandbox_status }
```

```
PATCH /api/workspaces/:id
  auth: user JWT (workspace owner)
  body: { name? slug? }
  resp: { workspace }
```

```
DELETE /api/workspaces/:id
  auth: user JWT (workspace owner)
  side: 删 workspace_sandboxes + freeze sandbox + 删 OSS snapshot
```

### 2.3 Workspace Members

```
GET /api/workspaces/:id/members
  auth: user JWT (workspace member)
  resp: { members: [{ user_id, email, name, role, joined_at }] }
```

```
POST /api/workspaces/:id/members
  auth: user JWT (workspace owner/editor)
  body: { email, role: "editor" | "viewer" }
  resp: { member }
```

```
PATCH /api/workspaces/:id/members/:userId
  auth: user JWT (workspace owner)
  body: { role }
  resp: { member }
```

```
DELETE /api/workspaces/:id/members/:userId
  auth: user JWT (workspace owner)
  resp: 204
```

### 2.4 Files

```
GET /api/workspaces/:id/files
  auth: user JWT (workspace member)
  query: ?path=.  &depth=4
  resp: { tree: FsNode[], workspace, path }
  // FsNode = { name, type: "file"|"dir", path, size?, mtime?, children? }
```

```
GET /api/workspaces/:id/files/*
  auth: user JWT (workspace member)
  path: 文件相对路径
  resp: { path, content, size, mtime, content_hash }
  // 大文件: content 是 signed OSS URL
```

```
PUT /api/workspaces/:id/files/*
  auth: user JWT (workspace member, role ≥ editor)
  body: { content, expected_hash? }     // expected_hash 用于 ETag 校验
  resp: { path, content_hash, mtime }
  error: 409 if hash mismatch
  side: 写 workspace_files + edit_checkpoint + 推 SSE
```

```
DELETE /api/workspaces/:id/files/*
  auth: user JWT (workspace member, role ≥ editor)
  resp: 204
  side: 写 edit_checkpoint + 推 SSE
```

### 2.5 Run

```
GET /api/workspaces/:id/runs
  auth: user JWT (workspace member)
  query: ?session_id&status&limit&cursor
  resp: { runs: [...], next_cursor }
```

```
POST /api/workspaces/:id/runs
  auth: user JWT (workspace member, role ≥ editor)
  body: {
    prompt: string,
    session_id?: string,             // 不传 = 新 session
    system_prompt_override?: string,
    skill_ids?: string[],
    max_steps?: number,
    max_duration_ms?: number,
  }
  resp: { run: { id, status, session_id, ... } }
  side: 启动 sandbox (warm 复用 / freeze thaw / provision)
        签 scoped run token
        PUT 注入到 sandbox
        写 runs(status=created)
```

```
GET /api/runs/:id
  auth: user JWT (workspace member)
  resp: { run, last_acked_seq, event_count }
```

```
GET /api/runs/:id/stream   (SSE)
  auth: user JWT (workspace member)
  resp: text/event-stream
  event types:
    event: run.status_changed
    data: { from, to, at }
    event: agent.event
    data: { id, type, payload }    // = agent_events 表的一行
    event: tool.call
    data: { id, name, status, args, result, started_at, completed_at }
  心跳: 30s 一次 (event: ping)
```

```
POST /api/runs/:id/cancel
  auth: user JWT (workspace member, role ≥ editor)
  body: {}
  resp: { run: { id, status: "cancel_requested" } }
  side: UPDATE runs SET status='cancel_requested'
        下一轮 run-agent.ts 500ms poll 看到 → agent.abort()
        abort signal 触发 outboxPromise resolve → run 结束
        写 event: run_cancelled
```

### 2.6 Workspace Events（SSE）

```
GET /api/workspaces/:id/events   (SSE)
  auth: user JWT (workspace member)
  query: ?type=file.* | ?type=run.*  (可选过滤)
  resp: text/event-stream
  event types:
    event: file.created
    event: file.modified
    event: file.deleted
    event: run.started
    event: run.completed
    event: memory.proposed
    event: skill.proposed
  心跳: 30s 一次
```

### 2.7 Memory

```
GET /api/workspaces/:id/memory
  auth: user JWT (workspace member)
  query: ?scope=&status=active
  resp: { entries: [{ id, scope, content, tags, confidence, status, created_by, created_at }] }
```

```
GET /api/memory/:id
  auth: user JWT
  resp: { entry, revisions: [...] }
```

```
PATCH /api/memory/:id
  auth: user JWT (workspace member, role ≥ editor)
  body: { content, tags?, reason }
  resp: { entry, revision }
  side: 写新 revision，append memory_revisions
```

```
DELETE /api/memory/:id
  auth: user JWT (workspace member, role ≥ editor)
  resp: 204
  side: status='deleted'（不真删，可恢复）
```

### 2.8 Memory Proposals

```
GET /api/workspaces/:id/memory-proposals
  auth: user JWT (workspace member, role ≥ editor)
  query: ?status=pending
  resp: { proposals: [...] }
```

```
POST /api/memory-proposals/:id/approve
  auth: user JWT (workspace owner)
  resp: { entry }
  side: 写 memory_entries(status=active)
        推 SSE 给订阅者
        通知 agent（sandbox 内的 memory cache 失效）
```

```
POST /api/memory-proposals/:id/reject
  auth: user JWT (workspace owner)
  body: { note? }
  resp: 204
  side: status='rejected'
```

### 2.9 Skill

```
GET /api/workspaces/:id/skills
  auth: user JWT (workspace member)
  resp: { skills: [{ id, name, version, source, manifest, enabled, status }] }
```

```
POST /api/workspaces/:id/skills
  auth: user JWT (workspace owner)
  body: { name, version, source, manifest }
  resp: { skill }
  side: 物化到 sandbox /workspace/.skills/<name>/
```

```
DELETE /api/skills/:id
  auth: user JWT (workspace owner)
  resp: 204
  side: 从 sandbox 卸载
```

### 2.10 Skill Proposals

同 memory-proposals。

### 2.11 Notifications

```
GET /api/me/notifications
  auth: user JWT
  query: ?unread=true
  resp: { notifications: [...] }
```

```
POST /api/me/notifications/:id/read
  auth: user JWT
  resp: 204
```

### 2.12 Events Ingest（sandbox 调）

```
POST /api/events/ingest
  auth: scoped run token
  body: {
    events: [
      {
        event_id: "run_456:42",
        workspace_id: "ws_123",
        session_id: "sess_789",
        run_id: "run_456",
        seq: 42,
        type: "tool_call_completed",
        actor: "agent:run_456",
        payload: { ... },
        created_at: "2026-06-28T13:21:56.948Z"
      },
      ...
    ]
  }
  resp: {
    acked_through_seq: 42,
    missing_seq: []           // 服务端发现的洞，sandbox 应已自动补
  }
  error: 
    401 if token invalid / expired
    403 if token 权限不够
    400 if event_id format wrong / workspace_id mismatch
```

**DB 写入（事务）**：
```sql
BEGIN;
  -- 1. agent_events (幂等)
  INSERT INTO agent_events (...) VALUES (...)
  ON CONFLICT (id) DO NOTHING;
  
  -- 2. tool_calls（如果是 tool event）
  INSERT INTO tool_calls (...) VALUES (...)
  ON CONFLICT (id) DO UPDATE SET ...;
  
  -- 3. runs.last_acked_seq
  UPDATE runs SET last_acked_seq = GREATEST(last_acked_seq, $max_seq)
    WHERE id = $run_id;
  
  -- 4. 推 Redis pub/sub
  PUBLISH workspace:<id>:events <event_json>;
COMMIT;
```

**SSE fanout**（control plane 内部，独立 worker）：
```
redis_subscriber:
  loop:
    msg = redis.pubsub.listen("workspace:*:events")
    for each workspace subscriber (memory):
      sse.send(msg)
```

### 2.13 Sandbox Manifest Injection

```
PUT /api/agent-server/:key/manifest
  auth: scoped run token
  body: {
    workspace_id, run_id, session_id, user_id,
    system_prompt,
    skill_snapshot: [{ name, version, manifest }],
    memory_snapshot: [{ id, content, scope, tags }],
    files: { path: content }
  }
  resp: 204
  side: sandbox 把 files 写到 /workspace
        skill 物化到 /workspace/.skills/<name>/
        memory cache 写到 /workspace/.memory/
        agent-daemon 启动 Pi Agent loop
```

## 3. 错误码

| Code | 含义 |
|---|---|
| 400 | 请求格式错（zod 校验失败） |
| 401 | 鉴权失败（无 token / 过期） |
| 403 | 权限不足（role 不够） |
| 404 | 资源不存在 / 跨 org（统一 404，不暴露存在性） |
| 409 | 冲突（ETag / 状态机非法转移） |
| 422 | 业务规则拒绝（如 agent 提议 skill 不合法） |
| 429 | 限流（P1） |
| 500 | 服务端错误 |
| 503 | Sandbox 暂时不可用 |

错误响应统一：
```json
{
  "error": {
    "code": "string_code",
    "message": "human readable",
    "details": { ... }
  }
}
```

## 4. 限流（P1）

```
- POST /runs:  10/min per user
- POST /files: 100/min per user
- POST /events/ingest: 无限制（sandbox 内部）
```

## 5. 旧 API 变化

| 旧 | 新 | 原因 |
|---|---|---|
| `/api/sessions` 直挂在根 | `/api/workspaces/:id/sessions` | workspace 优先 |
| 无 `orgs` 概念 | 全 `/api/orgs/:orgId/...` | 多租户 |
| `/api/runs/:id/events` 一次返回 | `/api/runs/:id/stream` SSE | 实时 |
| 无 `events/ingest` | 强制走 ingest | 信任边界 |
| 无 scoped run token | 强制 scoped | 信任边界 |
| 状态机不严格 | 严格 9 状态机 | ADR-0007 |
| 跨 org 403 | 跨 org 404 | 不暴露存在性 |


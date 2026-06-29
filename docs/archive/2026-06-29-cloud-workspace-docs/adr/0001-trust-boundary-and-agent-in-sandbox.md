# ADR-0001：信任边界与 Agent 部署位置

- 状态：已采纳
- 日期：2026-06-28
- 取代：archived `0001-sandbox-as-tool.md`（范式 A → 范式 B）
- 关键词：trust boundary、agent-in-sandbox、scoped token

## 背景

旧 ADR-0001 把 agent loop 放在 server 端，sandbox 只是"工具伸手进去"（范式 A）。这种设计在原型期够用，但有 3 个不可调和的痛点：

1. **"agent 跑在沙箱里"是用户/客户的硬要求**—— 面试官、潜在客户、安全 review 一致反馈：生产级 agent 系统必须把 agent 进程放在隔离域里
2. **协作场景下 server 端 agent loop 状态难共享**—— 多人多 run 共享一个 workspace 时，agent loop 在 server 意味着每个 sandbox 实例都要把状态 push 回 server，方向反了
3. **sandbox 内的中间状态（thinking、tool pending、local cache）无处可放**—— 强行塞 DB 会引入双写

## 决定

### 信任边界划在 sandbox 边缘

```
┌─────────────────────────────────────────────┐
│ Control Plane (可信)                         │
│   - Postgres (Neon) — 事实源                 │
│   - Workspace/Memory/Skill catalog           │
│   - Ingest API (POST /events/ingest)         │
│   - 鉴权 / 审批 / 通知                        │
└─────────────────────────────────────────────┘
        ▲              │
        │ POST events  │ scoped run token
        │ + ack        │ (short-lived)
        │              ▼
┌─────────────────────────────────────────────┐
│ Cloud Sandbox (不可信)                       │
│   /workspace/files                          │
│   /workspace/.agent/  (本地 WAL, 不外传)    │
│   /workspace/.memory/ (cache)               │
│   /workspace/.skills/ (物化)                │
│   agent daemon (Fastify+WS)                 │
│   Pi Agent loop (本地)                      │
│   凭证: 只有 scoped run token               │
│   ❌ 无 DB 凭证                              │
│   ❌ 无 Redis 凭证                           │
└─────────────────────────────────────────────┘
```

### 5 条不变量

1. **sandbox 不可信** — 不下发 Postgres / Redis 凭证，不下发长期 API key
2. **sandbox 只持 scoped run token** — JWT，签发时含 `workspace_id + run_id + permissions + exp`（默认 = run 生命周期）
3. **所有状态变化先成 event** — agent 内部任何状态变更必须先写 outbox
4. **DB 单一写入路径** — 只有 ingest API 能写 `agent_events` / `runs` / `tool_calls` / `artifacts`
5. **transcript 永远不离开 sandbox 强同步** — sandbox 内有完整 sqlite WAL，DB 是镜像而不是反之

### Sandbox 权限（scoped token claims）

```json
{
  "iss": "control-plane",
  "sub": "sandbox:<sandbox_id>",
  "workspace_id": "ws_123",
  "run_id": "run_456",
  "permissions": [
    "events:ingest",
    "files:read:workspace",
    "files:write:workspace",
    "exec:workspace"
  ],
  "exp": 1234567890,
  "jti": "unique-token-id"
}
```

**禁用列表**（永远不在 token 里）：
- `db:write:any` — 禁止 sandbox 写 Postgres
- `sandbox:create`、`sandbox:stop` — 不能起停别的 sandbox
- `cross:workspace:read` — 不能读别的 workspace

## 范式对比

| 维度 | 范式 A (旧) | 范式 B (新) |
|---|---|---|
| agent loop | server | sandbox |
| transcript | DB 单源 | sandbox sqlite + DB 镜像 |
| 同步模型 | fire-and-forget HTTP | outbox + idempotent ingest + ack |
| sandbox 凭证 | Vercel SDK token | scoped run token only |
| 冷启动 | 每次新 sandbox | 复用 + freeze/thaw |
| 多 run 协作 | 难（agent loop 串行） | 自然（sandbox 内并发） |

## 不做什么

- ❌ 不让 sandbox 直接连 Postgres
- ❌ 不让 sandbox 直接连 Redis
- ❌ 不让 agent 写完直接 INSERT 到控制面（必须走 outbox → ingest）
- ❌ 不把"agent 是否在沙箱里"做成配置开关（必选，强制隔离）

## 后果

- 多了 1 层同步协议（outbox + ingest + ack），代码复杂度上升
- ingest API 必须是高可用 + 幂等 + 重试
- sandbox 冷启动时要把 token + manifest 一起注入，token 失效要能平滑续期
- 调试更复杂：现在出 bug 要同时看 sandbox 内 sqlite + DB event log
- UI 不能直接订阅 sandbox（必须经 server 转发事件）


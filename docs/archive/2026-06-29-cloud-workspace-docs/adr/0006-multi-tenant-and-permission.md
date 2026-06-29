# ADR-0006：多租户与权限模型

- 状态：已采纳
- 日期：2026-06-28
- 依赖：ADR-0001
- 关键词：multi-tenant、RBAC、org、workspace member

## 背景

产品定位是企业协作空间 → 必须有：

- Org：公司/团队
- User：成员
- Workspace：协作单元（一个项目 = 一个 workspace）
- Role：在 workspace 内的角色

如果 P0 不把多租户 + 权限立住，后面补就是 10x 成本。

## 决定

### 实体关系

```
Org (1) ─── (N) User ─── via OrgMember (role: owner/admin/member)
Org (1) ─── (N) Workspace
User (N) ─── (N) Workspace ─── via WorkspaceMember (role: owner/editor/viewer/commenter)
Workspace (1) ─── (N) Session ─── (N) Run
Workspace (1) ─── (N) Memory / Skill
```

### Schema

```sql
CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT DEFAULT 'free',     -- free/pro/enterprise
  created_at TIMESTAMPTZ
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ
);

CREATE TABLE org_members (
  org_id TEXT,
  user_id TEXT,
  role TEXT NOT NULL,           -- owner/admin/member
  joined_at TIMESTAMPTZ,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ
);

CREATE TABLE workspace_members (
  workspace_id TEXT,
  user_id TEXT,
  role TEXT NOT NULL,           -- owner/editor/viewer/commenter
  invited_by TEXT,
  joined_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX ON workspace_members (user_id);  -- 「我的 workspace」查询
```

### 角色矩阵

| 操作 | owner | editor | viewer | commenter |
|---|---|---|---|---|
| view workspace | ✓ | ✓ | ✓ | ✓ |
| read files | ✓ | ✓ | ✓ | ✓ |
| write files (直接) | ✓ | ✓ | ✗ | ✗ |
| 启动 run | ✓ | ✓ | ✗ | ✗ |
| approve proposal | ✓ | ✗ | ✗ | ✗ |
| invite members | ✓ | ✓ | ✗ | ✗ |
| change settings | ✓ | ✗ | ✗ | ✗ |
| delete workspace | ✓ | ✗ | ✗ | ✗ |
| comment in chat | ✓ | ✓ | ✗ | ✓ |

**`commenter`**：只读 + chat 评论（不能改文件，不能跑 agent）。**P0 不做** commenter 角色，**P0 只做 owner/editor/viewer**。

### 鉴权流程

```python
# 每次 API 请求
def authn(req):
    token = req.headers["Authorization"].removeprefix("Bearer ")
    claims = jwt.verify(token, signing_key)
    # claims: { sub: user_id, org_id, exp }
    return claims

def authz(req, resource, action):
    claims = authn(req)
    user_id = claims["sub"]
    workspace_id = req.params.workspace_id
    role = SELECT role FROM workspace_members
           WHERE workspace_id=? AND user_id=?
    if not role:
        raise 403
    if not can(role, resource, action):
        raise 403
```

### JWT 内容

```json
{
  "iss": "control-plane",
  "sub": "user_uuid",
  "org_id": "org_uuid",
  "email": "alice@example.com",
  "exp": 1234567890
}
```

**scoped run token**（sandbox 用的）是另一个 token，参考 ADR-0001。

### "我的 workspace"查询

```sql
-- 用户 alice 能看到的所有 workspace
SELECT w.*, wm.role
FROM workspaces w
JOIN workspace_members wm ON wm.workspace_id = w.id
WHERE wm.user_id = 'alice'
ORDER BY w.updated_at DESC;
```

走 `workspace_members(user_id)` 索引。

### 沙箱内 token

sandbox 内只持 scoped run token（不持用户 JWT）：

```
sandbox 持:        scoped run token (workspace_id + run_id + permissions + exp)
control plane 持:   user JWT (用来看 user identity)
                     + 内部 sandbox↔server channel 验签 sandbox identity
```

sandbox 写 event 时：

```
POST /api/events/ingest
Authorization: Bearer <scoped run token>
Body: { events: [...] }

server 验证：
  - token 签名 OK
  - token.run_id == events[].run_id
  - token.expired == false
  - 落库时同时 UPDATE runs SET last_acked_seq=...
```

**关键**：sandbox 不能伪造"我替 user X 写文件"，因为 token 是 server 签的、绑了 run_id。

### 邀请流

```
owner 在 UI 邀请 user@example.com 加入 workspace (role=editor)
  → 写 workspace_members (status=pending, invited_by, invited_at)
  → 发 email（带 magic link）
  → user 点链接 → 注册/登录 → 改 status=active
```

**P0 简化**：直接按邮箱加成员（假设已经在平台注册过），不发邮件。

### Org 隔离

**所有 query 都带 org_id 过滤**：

```python
def get_workspace(workspace_id, user_claims):
    ws = SELECT * FROM workspaces WHERE id=?
    if ws.org_id != user_claims.org_id:
        raise 404   # 不要 403，避免泄露存在性
    return ws
```

不让 cross-org 资源泄露，连错误码都不暴露。

## 不做什么

- ❌ 不做 SSO / SAML（P1）
- ❌ 不做 IP 白名单（P1）
- ❌ 不做 audit log（先用 Postgres 触发器简单记一行，P1 单独建 audit_log 表）
- ❌ 不做 commenter 角色（P0 只 owner/editor/viewer）
- ❌ 不做"个人 workspace"（org 必有，user 注册时自动建 personal org）


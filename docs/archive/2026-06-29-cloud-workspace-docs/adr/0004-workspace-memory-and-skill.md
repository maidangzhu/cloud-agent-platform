# ADR-0004：Workspace-scoped Memory / Skill 资产

- 状态：已采纳
- 日期：2026-06-28
- 依赖：ADR-0001, ADR-0002
- 关键词：memory、skill、proposal flow、版本化资产

## 背景

企业级 workspace 区别于个人 agent 的关键：**团队资产**。

- team 在 workspace 里反复用同一组工具 → 应该是 skill
- team 反复引用同一段项目背景 → 应该是 memory
- 协作者新加入 → 自动看到已有 memory + 可用 skills

**朴素做法**（"prompt 字符串"）问题：

1. 不版本化 — 改了一行不知道对哪些 run 有影响
2. 不分类 — workspace 级、session 级、user 级混在一起
3. 不审批 — agent 自己造一段 memory 直接进 prompt，团队无法 review
4. 不检索 — 几百条 memory 全塞 prompt，浪费 token

## 决定

### 资产分层

```
Workspace
├─ files            ← 文件系统（agent 读写）
├─ memory           ← 知识资产（团队记忆）
│   ├─ workspace 级  (项目背景、约定、术语)
│   ├─ session 级    (本话题上下文)
│   ├─ user 级       (某个成员的偏好)
│   └─ org 级        (跨 workspace 的公司知识)
├─ skills           ← 工具集（团队定制的工具 + 指令）
├─ sessions         ← 聊天话题
└─ runs             ← 执行记录
```

### Memory 是版本化资产，不是字符串

```sql
CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,                -- null = org 级
  scope TEXT NOT NULL,              -- workspace/session/user/org
  owner_id TEXT,                    -- 谁的（user/org 级别时填）
  content TEXT NOT NULL,
  source_event_id TEXT,             -- 哪个 event 提取出来的
  confidence REAL DEFAULT 1.0,
  tags TEXT[],
  status TEXT DEFAULT 'active',     -- active/proposed/superseded/deleted
  created_by TEXT NOT NULL,         -- "user:uuid" | "agent:runId"
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);
CREATE INDEX ON memory_entries (workspace_id, scope, status);
CREATE INDEX ON memory_entries USING gin (tags);

CREATE TABLE memory_revisions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  content TEXT NOT NULL,
  prev_revision_id TEXT,
  edit_reason TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ
);
CREATE INDEX ON memory_revisions (memory_id, created_at);

-- 向量检索（P1）
CREATE TABLE memory_embeddings (
  memory_id TEXT PRIMARY KEY,
  embedding VECTOR(1536),
  model TEXT,
  created_at TIMESTAMPTZ
);
```

**3 件事 memory 必须支持**：
1. **可回滚** — 任何版本都能恢复（`memory_revisions` append-only）
2. **可归属** — `created_by` + `source_event_id` 一眼看出谁写的、哪条 event 触发的
3. **可检索** — `tags` + embedding（P1）

### Skill 是 manifest，不是 prompt

```sql
CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,                -- null = 全局
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  source TEXT NOT NULL,             -- builtin/team/agent-generated
  manifest JSONB NOT NULL,          -- { tools, instructions, trigger, requiredRole }
  enabled BOOLEAN DEFAULT true,
  status TEXT DEFAULT 'active',     -- active/proposed/deprecated
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  UNIQUE(workspace_id, name, version)
);

CREATE TABLE skill_proposals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  name TEXT,
  proposed_manifest JSONB,
  proposed_by TEXT,                 -- "agent:runId"
  reasoning TEXT,                   -- 为什么这个 skill 有用
  status TEXT DEFAULT 'pending',    -- pending/approved/rejected
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT
);
```

**skill manifest 结构**：

```yaml
name: doc-lint
version: 1.2.0
description: "检查 workspace 内 markdown 文档的 frontmatter 完整性"
instructions: |
  每次写完 .md 文件，调用 lint 工具。
  如果 frontmatter 缺 title 或 tags，提示用户补全。
tools:
  - name: lint_markdown
    parameters: { path: string }
    execute: "<inline code or endpoint>"
trigger:
  filePattern: "**/*.md"
  events: ["file.created", "file.modified"]
requiredRole: "editor"
```

### Proposal → Review → Install 流

```
agent 完成任务，发现有用模式
  → 写 event: skill_proposed
    { name, manifest, reasoning, source_events: [...] }
  → 写 event: memory_proposed
    { scope, content, source_event_id, tags, confidence }

control plane ingest
  → 落 skill_proposals / memory_proposals 表
  → 推 SSE 给 workspace owner
  → UI 显示「Agent 提议：X」

owner 审批
  → approved → materialize
     - skill: 写入 skills 表，status=active
              并 sandbox 内物化到 /workspace/.skills/<name>/SKILL.md
     - memory: 写入 memory_entries 表，status=active
              sandbox 内 cache 失效，下次 run 拉新
  → rejected → 写 status=rejected，记 audit
```

**关键：agent 不能跳过 proposal 直接 install**。SSE ingest API 不接受 `skill.create` / `memory.create` 事件类型——只有 `*_proposed`。

### Sandbox 内物化

sandbox 启动 / skill install 时：

```python
# control plane 推 skill manifest 到 sandbox
PUT /api/agent-server/{key}/skills/{name}
Body: { manifest: {...} }

# sandbox 端：
mkdir -p /workspace/.skills/{name}
cat > /workspace/.skills/{name}/SKILL.md <<EOF
---
name: {name}
version: {version}
...
---
{instructions}
EOF
# 工具函数写到 /workspace/.skills/{name}/tools.ts，由 agent 启动时动态 import
```

agent 启动时扫描 `/workspace/.skills/*/SKILL.md` + 加载 `tools.ts`，合并到自己的 tool registry。

### Memory 注入策略（不要全部塞 prompt）

```
agent prompt 构造：
  1. system prompt（基础）
  2. active skills 摘要（只列 name + 1 行 desc，~500 token）
  3. memory 检索：
     - scope=workspace 全部 active（不超过 50 条，按 confidence 排序）
     - scope=session 本 session 相关（用 tag 匹配 user prompt）
     - scope=user 当前用户的偏好（user_id 维度）
     - scope=org 命中 keyword 的（embedding 检索 P1）
  4. 当前 run 的 user prompt
  5. transcript（如果非首次）
```

**P0**：只做 workspace 级全量 + 简单 keyword 匹配 session 级。P1 加 embedding 检索。

## 不做什么

- ❌ 不让 agent 直接 INSERT memory_entries / skills
- ❌ 不做"sandbox 内自由创建全局 skill"（必须 proposal 流）
- ❌ 不把 memory 整段塞 prompt（必须有检索 + 截断）
- ❌ 不做 cross-workspace memory 共享（P1）
- ❌ P0 不做 embedding（先用 tag + 简单 keyword）


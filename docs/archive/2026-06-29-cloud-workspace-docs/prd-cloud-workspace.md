# 产品需求文档 (PRD) — Cloud Workspace

> **代号**：Cloud Workspace
> **定位**：企业级"AI 协作空间"——workspace = 一组共享文件 + 一组可委派任务的 agent
> **核心范式**：Cloud Workspace + Agent-in-Sandbox + Workspace-scoped Memory/Skills
> **取代**：archived 旧版 `prd.md`（"Cloud Agent Platform" — 单一 agent + sandbox 临时跑任务）

## 1. 一句话产品定义

一个 workspace = 一个企业的协作空间，里面有文件、有成员、有 agent。成员可以在 workspace 里改文件、写文档、跑 agent 任务，agent 真的跑在隔离沙箱里，所有事件实时同步给所有成员。

## 2. 背景

### 2.1 旧版的局限

旧版 PRD 把产品定位成"agent 任务运行平台"——用户提交自然语言任务，平台起一个 sandbox 跑完即扔。

这种定位有 3 个问题：

1. **不是"协作"**——workspace 是一次性的，没有成员、没有共享
2. **agent 不在沙箱里**——agent loop 在 server，sandbox 只是 fs 代理（范式 A）
3. **没有 memory/skill**——每次 run 都从零开始，团队资产不能沉淀

### 2.2 用户的新需求

> "整个链路是什么样子的，筛选和 DB 这些是怎么写的"
> "Cloud Workspace + Agent-in-Sandbox + Workspace-scoped Memory/Skills"
> "DB 是事实源，sandbox local session 是运行时 WAL / cache / resume state"
> "sandbox 不可信，只给 scoped run token"

**核心范式**：Trust boundary 划在 sandbox 边缘；事实源在 Postgres；sandbox 内有完整 runtime + 本地 WAL；事件经 outbox 同步、幂等 ingest、ack 闭环。

## 3. 目标用户

| 用户 | 诉求 |
|---|---|
| 企业团队 | 在一个 workspace 里协作：写文档、跑 agent 任务、积累 memory/skill |
| 个人高级用户 | 长期沉淀的 workspace，可随时叫 agent 续上之前的工作 |
| 评审者 | 验证"agent 跑在沙箱里 + 事件同步 + 团队资产"三件事的工程能力 |

## 4. 核心场景

### 4.1 P0 — 必须做

**场景 A：单用户启动 agent 改文件**

> Alice 在 workspace 里有 `diary.md`。她在右栏 chat 输入"加一行今天的进度"。左栏文件树自动出现 diary.md（已存在），中栏 preview 立刻刷新（agent 写入的），右栏 chat 显示 agent 调用 `read_file` → `write_file` 的进度。

**场景 B：多轮对话**

> Alice 接着说"再补一段关于 freeze/thaw 的笔记"。agent 看到对话历史，在 diary.md 追加新段落。

**场景 C：取消 + 超时**

> Alice 启动 run 后立刻意识到 prompt 错了，点 cancel。agent 进程 1s 内优雅退出，run 状态变 cancelled。如果不点 cancel，run 超过 30min 自动 timeout。

**场景 D：Sandbox 复用**

> Alice 5 分钟后再来，sandbox 还是 warm 状态，不需要再等 50s 冷启动。如果 1 小时后再来，sandbox 已 freeze，系统从 OSS 拉 snapshot 解压，10s 内可继续工作。

**场景 E：Memory 沉淀**

> Alice 跑完 3 个 run 后，agent 提议"我注意到这个项目用的是 react + fastify，要不要存一条 memory?"。Alice 审批通过，memory 进入 workspace。后续 run 启动时自动加载。

### 4.2 P1 — 下阶段

- 场景 F：多人协作（owner/editor/viewer）
- 场景 G：Skill 提议 → 审批 → 物化
- 场景 H：跨 workspace 检索（embedding）
- 场景 I：实时协作光标

### 4.3 P0 不做

- ❌ 跨 org 共享 workspace
- ❌ SSO / SAML
- ❌ 实时协作光标
- ❌ Embedding 检索（先用 tag + keyword）
- ❌ Commenter 角色
- ❌ Audit log 表（先用 Postgres 触发器简单记）

## 5. 功能列表

### 5.1 Workspace 管理

| 功能 | P0 | P1 |
|---|---|---|
| 创建 / 删除 / 重命名 workspace | ✓ | |
| 邀请成员（按 email） | ✓ | |
| Owner / Editor / Viewer 角色 | ✓ | |
| Org 概念 | ✓ | |
| Cross-org 隔离 | ✓ | |
| SSO / SAML | | ✓ |

### 5.2 文件管理

| 功能 | P0 | P1 |
|---|---|---|
| 文件树浏览 | ✓ | |
| 单文件读 | ✓ | |
| 单文件写（直接） | editor+ | |
| Markdown preview | ✓ | |
| Monaco code editor | | ✓ |
| 拖拽上传 | | ✓ |
| 大文件分块上传 | | ✓ |
| ETag 冲突检测 | ✓ | |

### 5.3 Agent 任务

| 功能 | P0 | P1 |
|---|---|---|
| 启动 run（单 prompt） | ✓ | |
| 多轮对话（session 复用） | ✓ | |
| 取消 | ✓ | |
| 工具：read_file / write_file / list_files / exec | ✓ | |
| 工具：grep / search | | ✓ |
| Run 状态可视化 | ✓ | |
| Run 历史查询 | ✓ | |
| Run stream（SSE） | ✓ | |

### 5.4 Memory

| 功能 | P0 | P1 |
|---|---|---|
| Workspace 级 memory | ✓ | |
| User 级 memory | ✓ | |
| Org 级 memory | | ✓ |
| Agent 提议 → 用户审批 | ✓ | |
| Tag + keyword 检索 | ✓ | |
| Embedding 检索 | | ✓ |
| 版本化（可回滚） | ✓ | |

### 5.5 Skill

| 功能 | P0 | P1 |
|---|---|---|
| 内置 skill（read/write/exec） | ✓ | |
| 团队自定义 skill | ✓ | |
| Agent 提议 → 用户审批 | ✓ | |
| Skill 物化到 /workspace/.skills/ | ✓ | |
| Skill 共享市场 | | ✓ |

### 5.6 Sandbox 生命周期

| 功能 | P0 | P1 |
|---|---|---|
| 创建 sandbox（Vercel microVM） | ✓ | |
| 复用 warm sandbox | ✓ | |
| Freeze（tar → OSS） | ✓ | |
| Thaw（拉 OSS → 解压） | ✓ | |
| Warm pool 预热 | | ✓ |
| Local 模式（dev） | ✓ | |

## 6. 非功能需求

| 维度 | 目标 |
|---|---|
| 冷启动 sandbox | P0: 50s; P1 (warm pool): 5s |
| 复用 warm sandbox | < 1s |
| Freeze 耗时 | < 30s |
| Thaw 耗时 | < 30s |
| Run 取消响应 | < 1s |
| 单 run 上限 | 30min / 30 步（可配） |
| Stale sweep | 5min 周期，30min 阈值 |
| 并发 run / workspace | 1（v1）→ 5（v2） |
| Workspace 文件数 | 10000 |
| 单文件大小 | 10MB |
| DB 写入延迟 | < 50ms p99 |
| SSE 推送延迟 | < 200ms p99 |
| 事件不丢 | 99.9%（依赖 outbox + idempotent ingest） |
| 事件不重 | 100%（ON CONFLICT DO NOTHING） |

## 7. 系统边界

### 7.1 在范围内

- 多租户（org/user/workspace）
- 文件 / memory / skill 资产
- Agent 任务（启动 / 取消 / 状态可视化）
- Sandbox 调度（warm / freeze / thaw）
- 事件流（sandbox → control plane → UI）
- 三栏 UI

### 7.2 不在范围内（P0）

- Agent 框架选择（绑定 Pi Agent，P1 抽象 WorkspaceDriver）
- Vector DB 自建（先用 Postgres tsvector，P1 评估 pgvector / 外部）
- 计费 / 订阅
- Webhook / API 开放
- 移动端
- 离线模式

## 8. 关键决策（指 ADR）

- [ADR-0001](adr/0001-trust-boundary-and-agent-in-sandbox.md) 信任边界 + Agent-in-Sandbox
- [ADR-0002](adr/0002-outbox-sync-protocol.md) Outbox 同步协议
- [ADR-0003](adr/0003-workspace-sandbox-lifecycle.md) Sandbox 生命周期
- [ADR-0004](adr/0004-workspace-memory-and-skill.md) Memory / Skill 资产
- [ADR-0005](adr/0005-ui-three-pane-and-realtime.md) UI 三栏 + 实时
- [ADR-0006](adr/0006-multi-tenant-and-permission.md) 多租户与权限
- [ADR-0007](adr/0007-run-cancel-and-timeout.md) 取消 / 超时 / 孤儿回收

## 9. 验收清单

P0 完成 = 下列全部能跑通：

- [ ] Alice 注册 → 自动建 personal org
- [ ] Alice 创建 workspace "我的笔记"
- [ ] Alice 邀请 Bob 为 editor
- [ ] Bob 进 workspace，看到文件树为空
- [ ] Bob 在右栏发 prompt "创建一个 hello.md，内容是 hello world"
- [ ] 30s 内 sandbox 起来
- [ ] agent 调 write_file 创建文件
- [ ] 左栏文件树实时出现 hello.md
- [ ] 中栏 preview 显示 hello.md
- [ ] Bob 点 cancel 在 1s 内生效
- [ ] Alice 不动 workspace 30min，sandbox 自动 freeze
- [ ] Alice 1 小时后回来，sandbox thaw < 30s
- [ ] Bob 跑 3 个 run 后，agent 提议 memory
- [ ] Alice 审批 memory，记忆被持久化
- [ ] 新 run 启动时自动加载 memory

## 10. 归档说明

旧文档已归档到 [archive/](archive/)：

- `archive/adr/0001-sandbox-as-tool.md` 等 5 个旧 ADR
- `archive/sandbox-research.md` 旧调研

新方案从 2026-06-28 起生效，旧方案不再维护。

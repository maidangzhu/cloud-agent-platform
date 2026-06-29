# P0 演进路线 — 从旧 OpenSpec 到 Cloud Workspace 最小闭环

> 目标：把当前项目从“旧 Cloud Agent Platform MVP”收口到“面试能讲清楚的 Cloud Workspace P0”。
> 原则：先能讲清楚，再一点点改代码；每一步都有可验收结果。

## 1. 当前问题

现在让人看不懂的核心原因不是代码太多，而是有三套范围混在一起：

| 层 | 当前状态 | 问题 |
|---|---|---|
| 旧 OpenSpec | `openspec/changes/cloud-agent-platform-mvp` | 描述的是旧范式：server 跑 agent，sandbox 更像文件/命令工具 |
| 新 docs | `docs/prd.md` / `architecture.md` / ADR | 描述的是企业级 Cloud Workspace，范围偏大 |
| 真实目标 | 面试能讲清楚的 P0 demo | 只需要 5 个故事，不需要企业级全量实现 |

所以接下来不应该继续在旧 OpenSpec 上打补丁，也不应该立刻实现完整新架构。正确动作是：

1. 归档旧 OpenSpec，保留历史。
2. 建一个新的 P0 OpenSpec，只描述最小闭环。
3. 每次只做一个小 change，做完再进入下一个。

## 2. 新架构一句话

Cloud Workspace 的最小形态是：

> Control Plane 负责鉴权、Run 状态、沙箱调度和事件展示；Agent loop 运行在 sandbox 内；sandbox 不能拿 DB/Redis 凭证，只能用 scoped run token 把事件上报给 control plane。

最小架构图：

```text
Browser
  |
  | POST run / cancel / SSE stream
  v
Control Plane (Next.js + Postgres)
  |
  | start sandbox + send manifest + scoped run token
  v
Sandbox
  |
  | agent loop + tools + local files
  | append local event/outbox
  v
Control Plane ingest
  |
  | write AgentEvent / ToolCall / Run status
  v
Browser SSE
```

## 3. P0 只保留 5 个故事

| P0 故事 | 面试里讲什么 | 验收方式 |
|---|---|---|
| 1. agent 改文件端到端 | 用户 prompt 触发 agent 写 workspace 文件 | curl 或 UI 创建 `hello.md`，能读到文件 |
| 2. cancel 1s 内响应 | run 状态机 + abort signal + 轮询取消 | 点 cancel 后 1s 内终态为 `cancelled` |
| 3. LLM 卡死兜底 | fallback / retry / first-response timeout / run timeout | 单测通过，能解释 race fix |
| 4. agent 跑在 sandbox | 信任边界：server 不跑 agent loop | sandbox 内有 daemon + agent runner |
| 5. warm/cold 复用 | sandbox lifecycle，避免每次 50s 冷启动 | 同 workspace 第二次 run 明显复用 |

P0 明确不做：

- Memory / Skill proposal 审批流
- 多人协作
- embedding 检索
- 完整 outbox + ack offset 生产协议
- freeze/thaw OSS 快照
- 完整 Org/User/RBAC

这些可以留在 PRD/ADR 里当“未来演进”，但不能进入 P0 OpenSpec tasks。

## 4. 旧 OpenSpec 处理策略

### 4.1 `cloud-agent-platform-mvp`

结论：应该归档。

原因：

- 它已经基本完成，tasks 大多是 `[x]`。
- 它描述的是旧 MVP，不是新 Cloud Workspace P0。
- 继续修改它会让“旧范式 A”和“新范式 B”混在一个 change 里。

建议动作：

```bash
mkdir -p openspec/changes/archive
mv openspec/changes/cloud-agent-platform-mvp \
  openspec/changes/archive/2026-06-29-cloud-agent-platform-mvp
```

注意：当前机器没有 `openspec` CLI，所以先用手工移动。移动前不需要 sync 到 `openspec/specs`，因为这些 spec 会污染新 P0 口径。

### 4.2 `agent-eval-monitoring`

结论：暂时冻结，不进入 P0。

原因：

- Eval/monitoring 是有价值的，但它不是当前“讲清楚新架构”的第一优先级。
- LLM 卡死诊断脚本已经有部分价值，可以作为辅助工具保留。

建议动作：

```bash
mv openspec/changes/agent-eval-monitoring \
  openspec/changes/archive/2026-06-29-agent-eval-monitoring-paused
```

如果你想保守一点，也可以先不移动，只在 README/路线图里标记 paused。

## 5. 新 OpenSpec 拆分方式

不要建一个巨大的 `cloud-workspace-enterprise` change。P0 要拆成 5 个小 change：

```text
openspec/changes/
  cloud-workspace-p0-baseline/
  run-cancel-timeout-hardening/
  sandbox-agent-loop/
  sandbox-warm-reuse/
  demo-script-and-interview-story/
```

每个 change 都应该包含：

- `proposal.md`：为什么做、范围是什么、不做什么
- `design.md`：最小技术方案
- `tasks.md`：能逐项勾选的小任务
- `specs/<capability>/spec.md`：验收行为，不写实现细节

## 6. 最小演进顺序

### Step 0：文档收口

目标：先让人看懂。

任务：

- [ ] 归档旧 OpenSpec。
- [ ] 新建 `cloud-workspace-p0-baseline`。
- [ ] 把 PRD 的 P0 改成“面试 P0”，把 Memory/Skill/多人/freeze-thaw 降到 P1/P2。
- [ ] 保留 ADR，但在索引里标清：哪些是 P0 必须，哪些是未来演进。

验收：

- 任意人读 `docs/README.md`，能知道先看哪 4 个文件。
- `openspec/changes/` 里只有当前正在做的 P0 change。

### Step 1：P0 baseline

目标：保留现在已经跑通的能力，不急着重构。

任务：

- [ ] 确认现有 agent 改文件链路能 demo。
- [ ] 确认 LLM fallback 单测全绿。
- [ ] 确认 cancel race fix 可讲清楚。
- [ ] 记录当前 PoC 架构：哪些还在 server，哪些已经在 sandbox。

验收：

- 能用 5 分钟讲清楚“现在能跑什么、哪里还不是最终架构”。

### Step 2：agent loop 进 sandbox

目标：完成最关键的范式切换。

任务：

- [ ] 定义 sandbox runner 接口：`POST /run`、`POST /cancel`、`GET /health`。
- [ ] control plane 只创建 Run、调度 sandbox、转发 cancel。
- [ ] sandbox 内执行 agent loop。
- [ ] sandbox 通过 HTTP 把事件回传 control plane。
- [ ] 保持 DB/Redis 凭证只在 control plane。

验收：

- server 端不再直接调用 LLM 执行 agent loop。
- sandbox 内能根据 prompt 写文件。
- UI 或 curl 能看到 run events。

### Step 3：cancel + timeout hardening

目标：把“卡死不会无限卡”讲扎实。

任务：

- [ ] cancel API 设置 `cancel_requested`。
- [ ] sandbox runner 1s 内收到 cancel 并 abort。
- [ ] LLM first-response timeout 生效。
- [ ] run max duration 生效。
- [ ] sweep 脚本能收敛 orphan run。

验收：

- cancel demo 能稳定 1s 内结束。
- 单测覆盖 LLM half-open race。

### Step 4：warm sandbox 复用

目标：让“cloud workspace”有体感。

任务：

- [ ] workspace 绑定 sandbox handle。
- [ ] 同 workspace 第二次 run 优先复用 warm sandbox。
- [ ] 记录 cold start / warm reuse 时间。
- [ ] UI 或日志展示复用结果。

验收：

- 第一次 run 是 cold start。
- 第二次 run 明显更快。

### Step 5：面试 demo 脚本

目标：能讲，不只是能跑。

任务：

- [ ] 准备 5 分钟 demo 脚本。
- [ ] 准备 2 分钟架构图讲解。
- [ ] 准备 3 个追问答案：为什么 sandbox 不可信、为什么 Postgres 是事实源、为什么需要 timeout 四层兜底。

验收：

- 不看代码也能讲清楚主链路。
- 看代码时能指出 3 个关键文件。

## 7. 领域词汇表入口

读新架构时，优先区分这 6 个词：

| 词 | 最小定义 |
|---|---|
| Workspace | 用户看到的协作空间；P0 可以先等价为“一组文件 + run 历史” |
| Run | 一次 agent 执行，有严格状态机 |
| Session | 多轮对话容器；P0 可弱化 |
| Control Plane | 可信服务端，持 DB/Redis 凭证 |
| Sandbox | 不可信执行环境，跑 agent loop 和工具 |
| Scoped Run Token | sandbox 唯一能拿到的短期权限 |

完整词汇表见 `docs/glossary.md`。

## 8. 当前最需要确认的问题

这是 grill 的第一组问题，只问 P0：

1. P0 是否允许“单用户、无登录、固定 workspace”？如果允许，Org/User/RBAC 全部先不做。
2. P0 的“agent 跑在 sandbox”是否接受 local sandbox 模式先跑通？如果接受，Vercel microVM 只做加分演示。
3. P0 是否把多轮对话降级为“同 workspace 连续 run”？如果接受，Session 只做轻量容器。
4. P0 是否把 freeze/thaw 改成 P1，只保留 warm reuse？如果接受，先不碰 OSS。

建议答案：

- 1：允许。
- 2：允许，但接口必须和 cloud sandbox 一致。
- 3：允许。
- 4：允许。

这样范围会小很多，且面试故事仍然完整。

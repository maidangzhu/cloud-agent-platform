# ADR-0007：卡死诊断模型 —— (最后事件 type, heartbeat 新鲜度) 二维定位

**状态：** 已接受（2026-07-02）

## 决策

用两个已有信号组合，直接定位一个 run "卡在哪"：

1. **最后一个 `AgentEvent` 的 `type`** —— 它上次活着时正在干哪个阶段。
2. **`Run.lastHeartbeatAt` 的新鲜度** —— 它上次证明自己还活着是什么时候。

heartbeat 增加携带 **`phase`**（如 `waiting_llm` / `running_tool:fetch_url`），用于区分"死等 / 死循环 / 进程已死"。

## 卡死诊断表

| 最后事件 type | 且超过阈值无新事件 | 几乎可断定卡在 |
|---------------|-------------------|---------------|
| `run_created` | 无 `sandbox_ready` | 沙箱没建起来（provider 慢/失败） |
| `sandbox_ready` | 无 `agent_started` | runner 进程没起来 / 启动脚本崩了 |
| `agent_started` / `model_step` | 无 `tool_call_started` | 卡在等 LLM（proxy 慢/中转站挂/模型 hang） |
| `tool_call_started` | 无 `tool_call_completed` | 卡在工具执行（fetch 不响应站、命令死循环） |
| 任意 | `lastHeartbeatAt` 也过期 | 整个 runner 进程没了（OOM/崩溃） |
| 任意 | `lastHeartbeatAt` 仍新鲜但无新业务事件 | runner 活着但逻辑卡死（死循环/死等） |

最后两行是区分"进程挂了 vs 没挂"的关键：heartbeat 停 = 进程真死；heartbeat 在跳但业务不前进 = 进程活着卡在工具/死循环。

## 三条埋点纪律（P0 必须遵守）

1. **每个阶段转换发事件，绝不留黑盒。** 工具调用必须成对 `started` / `completed|failed|timeout`，不允许只有 started 没有结尾。
2. **每条事件/日志带 `runId` + `workspaceId` + 时间戳（结构化）。** 后台 `WHERE runId=xxx ORDER BY seq` 即可摊开一个 run 的一生。
3. **heartbeat 带当前 phase，而非空跳。** 这是"死等 vs 死循环"的唯一信号。

## 阈值分层

- **60s = 黄灯告警阈值**（标记 possibly_stuck，可观测性亮灯），不等于击杀。
- **击杀 = heartbeat 彻底过期 + 每工具独立 timeout**（LLM 60s、fetch 120s、run_command 可配）。
- 需与 state-machines.md 现有 heartbeat fresh 阈值（30s）对齐，避免两处打架。

## 背景

v1 的根本痛点："跑着跑着没反应，不知道死在哪、卡在谁。"根因不是缺指标，是缺乏对"正常"的定义——说不出"此刻它应该在干什么"。本模型用最小信号回答这个问题。

## 连锁影响

- `HeartbeatRequest` 增加 `phase` 字段（现仅有 `seq?` / `status?`）。
- P0 观测平台无需花哨 UI，就是把此表用 SQL 表达的"卡住检测"脚本（对齐 agent-eval-monitoring 提案）。
- 依赖 [ADR-0008](./0008-sweep-safety-net.md) 的 sweep 执行强制收敛。

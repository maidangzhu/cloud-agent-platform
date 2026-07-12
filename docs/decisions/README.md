# 架构决策记录（ADR）

这个目录记录本项目在设计打磨过程中敲定的架构决策。每条 ADR 记录一个**已解决**的决策：决策内容、背景、被否方案、连锁影响。

未解决的问题记录在 [OPEN-QUESTIONS.md](./OPEN-QUESTIONS.md)。

## 索引

| ID | 决策 | 状态 |
|----|------|------|
| [0001](./0001-execution-model.md) | 执行模型采用 Agent-in-Sandbox（点火器 + 收信箱） | 已接受 |
| [0002](./0002-product-spine.md) | 产品脊柱锁定为研究工作区 Agent；主动对外划出范围 | 已接受 |
| [0003](./0003-sandbox-snapshot-vs-source-of-truth.md) | 沙箱用快照加速复用；Control Plane 仍是文件/artifact 事实源 | 已接受 |
| [0004](./0004-ingest-queue.md) | Ingest 采用超薄同步写库 P0 形态，按可插队列的管线分层 | 已接受 |
| [0005](./0005-single-tenant-enterprise-quality.md) | 定位 = 单租户功能范围 + 分布式系统级工程质量 | 已接受 |
| [0006](./0006-event-seq-at-source.md) | 事件 seq 由沙箱源头分配，消费者按 (runId, seq) 幂等 | 已接受 |
| [0007](./0007-stuck-diagnosis-model.md) | 卡死诊断模型：(最后事件 type, heartbeat 新鲜度) 二维定位 | 已接受 |
| [0008](./0008-sweep-safety-net.md) | Sweep 兜底：绝不允许 run 永久停留在 running | 已接受 |
| [0009](./0009-provider-anti-corruption-layer.md) | Provider 防腐层：fallback/retry/超时/reasoning 归一收敛于 LLM Proxy | 已接受 |
| [0010](./0010-frontend-agui-protocol.md) | 前端协议采用 AG-UI；表现层用 shadcn 自绘 | 已接受 |
| [0011](./0011-dual-channel-streaming.md) | 双通道数据流：token 流低延迟直通，业务事实先落库 | 已接受 |
| [0012](./0012-product-niche-alt-research.md) | 产品壳收窄为"开源平替技术方案调研 Agent" | 已接受 |
| [0013](./0013-mechanism-deep-dive-refinement.md) | 产品叙事收窄为"机制级深挖"；两阶段交互；措辞纪律；验证边界 | 已接受 |
| [0014](./0014-pre-run-file-sync.md) | Run 启动前的文件水合机制——版本号水位线 + 增量 diff | 已接受 |
| [0015](./0015-usage-telemetry-and-ops-priorities.md) | Credit 改为用量遥测；后端工程缺口优先级拍板 | 已接受 |
| [0016](./0016-token-stream-relay-redis-pubsub.md) | Token 流跨实例转发——引入 Redis Pub/Sub，解决 DQ-2 | 已接受 |
| [0017](./0017-token-accumulation-and-persistence-timing.md) | Token 攒批的位置与落库时机——沙箱内存攒、语义边界触发落库 | 已接受 |
| [0018](./0018-atomic-state-transitions.md) | 状态变更统一走条件原子 UPDATE，禁止 check-then-act | 已接受 |
| [0019](./0019-waiting-for-input-state.md) | 新增 `waiting_for_input` 状态并下沉到协议全链路；解决 DQ-1 | 已接受 |
| [0020](./0020-agent-event-payload-schema-and-tool-retry.md) | AgentEventDTO.payload 判别联合 schema；工具失败重试协议；解决 DQ-3 | 已接受 |
| [0021](./0021-token-stream-relay-redis-streams.md) | Token 转发原语从 Redis Pub/Sub 改为 Redis Streams + cursor，修正 ADR-0016 | 已接受 |
| [0022](./0022-monorepo-hono-backend.md) | 后端采用 Hono，项目重构为 pnpm workspaces monorepo | 已接受 |
| [0023](./0023-control-plane-stream-fanout.md) | LLM delta 在 Control Plane 直接双路转发到 Sandbox 与 Redis | 已接受 |

## 惯例

- 文件名：`NNNN-kebab-case-title.md`。
- 状态：`已接受` / `已废弃` / `被取代`（注明取代者）。
- 决策一旦被后续 ADR 推翻，不删除原文件，改状态为 `被取代` 并链接新 ADR。

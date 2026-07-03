# 待决问题（OPEN QUESTIONS）

这里记录设计打磨中**尚未拍死**的问题。每条注明背景、选项、倾向、影响面。解决后升级为 ADR 并从本文件移除。

---

## DQ-1：（已解决，见 [ADR-0019](./0019-waiting-for-input-state.md)）

新增 `waiting_for_input` 状态，不做"resume 同一个 run"——沙箱上报后进程正常退出（run 转为已完成的一种终态邻居状态），用户回答直接复用 `POST /api/threads/:threadId/runs` 创建 Stage 2 新 run。状态机/SSE 事件/composer 规则三处已同步落地。

---

## DQ-2：（已解决，见 [ADR-0016](./0016-token-stream-relay-redis-pubsub.md)，机制细节由 [ADR-0021](./0021-token-stream-relay-redis-streams.md) 修正）

技术方案已定：引入 Redis 做跨实例转发，token 级实时流在纯 Vercel 架构下可行。转发原语从 pub/sub 改为 Streams + cursor，解决了 ADR-0016 遗留的"建连竞态"和"重连空洞"两个未覆盖问题。P0 直接实现（不降级到 P1），已通过 Redis(Upstash) PoC 验证。

---

## DQ-3：（已解决，见 [ADR-0020](./0020-agent-event-payload-schema-and-tool-retry.md)）

`POST /api/search-proxy` 已正式补进 api-contract.md（scoped run token、key 留 Control Plane、记用量）。HTML 清洗放 sandbox runner 侧。同时补齐了 `web_search`/`fetch_url` 的失败/重试协议。

---

## DQ-4：AgentEventDTO 是否直接对齐 AG-UI 事件 schema

**背景：** 见 [ADR-0010](./0010-frontend-agui-protocol.md)。

**倾向：** 对齐（前端少写适配），代价是被 AG-UI schema 绑定。待前端开工前定。

**说明：** [ADR-0020](./0020-agent-event-payload-schema-and-tool-retry.md) 已经把 `AgentEventDTO.payload` 定义为判别联合 schema，这是独立于"是否对齐 AG-UI"的决策——payload 内部字段形状已确定，DQ-4 剩余的问题收窄为"外层事件包裹结构（如 `type` 字段命名、是否需要额外的 AG-UI 专属包裹字段）是否要向 AG-UI 对齐"，影响面比之前小。仍待前端开工前定。

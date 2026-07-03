# ADR-0011：双通道数据流 —— token 流低延迟直通，业务事实先落库

**状态：** 已接受（2026-07-02）

## 决策

区分两类数据，走两条不同的路。"一切先落库再吐给前端"的原则**仅约束业务事实，不约束 token 流**。

| 数据 | 特点 | 路径 | 落库 |
|------|------|------|------|
| **思考 / 说话的 token 流** | 海量、瞬时、可重放可丢 | 低延迟直通：沙箱 → Control Plane → 前端 SSE，边转发边异步落库（fire-and-forget，不阻塞转发） | 落**最终聚合整段**（`TEXT_MESSAGE_END` 时落一条 message），不落每个 token |
| **业务事实**（tool_call、file_written、artifact_created、run 终态） | 少量、关键、必须持久 | 可靠通道：沙箱 → ingest → 确认落库 → 再广播 | **必须先落库**，幂等、有 seq |

## 关键洞见

token 流是**可重放的**——前端断线重连时从 DB 拿"最后那段完整文本"重建即可，无需每个 token 都持久化。掉几个 token 不影响正确性，因为最终整段会落库、刷新能恢复。因此：

- **token 流：** 低延迟优先，先吐前端，异步落聚合段。
- **业务事实：** 正确性优先，先落库再广播。这才是 sweep/审计/artifact 恢复依赖的东西。

## 工具调用不是流，是状态跳变

工具调用属业务事实，**不像 token 逐字符流**，而是离散状态跳变：

```
tool_call_started（整条，带工具名+参数）→ 前端画一行"正在执行 fetch_url"
tool_call_completed（整条，带结果）      → 那一行变完成态
```

一截一截的状态事件，要落库。对应用户要求"工具调用一行一截，不是串口传"。

## 未解风险（重要）

低延迟 token 直通需要沙箱到 Control Plane 之间一条**持续连接**。但 Control Plane 是无常驻的 Vercel 函数，单实例撑不起 30 分钟持续转发（撞 300s 上限）。因此"纯 Vercel 上 token 级实时流"本身是难题，可能需：

- 前端 SSE 轮询 DB 最新 token 段来近似，或
- 沙箱把 token 流写到前端可订阅的中间层（Redis pub/sub / Vercel 流式基础设施）。

详见 OPEN-QUESTIONS **DQ-2**：P0 是否降级为"一截一截事件流"，token 级流式放 P1。

## 被否方案

- **一切（含 token）先落库再吐：** 每 token 走一趟写库，延迟毁掉流式体验，等同用户反对的"先收集再吐"。
- **一切（含业务事实）都只走内存不落库：** sweep/审计/artifact 恢复失效，破坏事实源原则。

## 连锁影响

- 影响 api-contract 的 SSE 设计与 frontend 的 SSE hook。
- 与 [ADR-0010](./0010-frontend-agui-protocol.md) 的 AG-UI 事件分层对应：`TEXT_MESSAGE_CONTENT`（高频 token，直通）vs `TOOL_CALL_END` / `RUN_FINISHED`（低频事实，可靠）。

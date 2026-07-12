# ADR-0023：LLM delta 在 Control Plane 直接双路转发到 Sandbox 与 Redis

**状态：** 已接受（2026-07-12）

## 决策

LLM provider key 只存在于 Control Plane，因此真实 provider stream 首先到达 LLM Proxy。LLM Proxy 收到每个归一化 delta 后立即并行转发：

```text
provider delta
  -> LLM Proxy SSE -> sandbox Pi runtime
  -> Redis Stream  -> 任意 API 实例上的 browser SSE
```

Control Plane 不累计 thinking/content，也不创建语义 RunEvent。Sandbox 消费同一条 SSE，在内存中累计完整段落，并在 provider 的语义边界到达后只写一次稳定事件。该语义累计与落库规则继续遵循 ADR-0017。

Sandbox 不再把从 LLM Proxy 收到的 delta 逐条 POST 回 `/api/ingest/stream-chunk`，否则会增加一次公网往返、重复写 Redis，并放大请求量。`/api/ingest/stream-chunk` 继续保留给旧 deterministic fixture 和非 LLM Proxy 产生的瞬时输出。

## 约束

- provider 请求必须使用真正 streaming transport，不能先取得完整 completion 再拆分。
- reasoning/content delta 必须在 provider terminal 之前进入 Redis 和 Sandbox SSE。
- tool call 参数可增量累计，但只在完整对象形成后交给 Pi runtime 执行。
- 首个 delta 已对外发送后禁止透明 retry/fallback，避免用户收到重复前缀；首个 delta 前仍可按 ADR-0009 重试。
- Redis 写入失败不得被伪装成成功的完整流；错误必须可观测，最终语义事件仍由 Sandbox 决定是否落库。

## 背景

旧实现让 Pi runtime 以 `stream:false` 调 LLM Proxy，等完整 reasoning/content 返回后再各写一次 `/api/ingest/stream-chunk`。这只验证了 Redis 传输设施，不能降低首字延迟。ADR-0017 当时假设 Sandbox 是唯一持续收到 provider token 的组件；引入 hosted LLM Proxy 后该前提已不成立，但其“只在 Sandbox 累计语义文本”的结论仍成立。

## 被否方案

- **Control Plane 完整响应后再切块：** 不是真流式，首字延迟等于完整生成耗时。
- **Sandbox 每个 delta 回 POST ingest：** 多一次公网往返，并造成每 token 级 HTTP 请求。
- **Control Plane 同时累计并落语义事件：** 与 Sandbox 形成两份状态，违反 ADR-0017。

## 连锁影响

- `llm/provider.ts` 增加 OpenAI-compatible SSE 防腐层。
- `llm/routes.ts` 在同一 delta 上执行 Sandbox SSE 与 Redis XADD 双路转发。
- Pi runtime adapter 与 standalone script 改为消费 LLM Proxy SSE。
- `LLM-W-106`/`LLM-W-107` 验证 delta 先于最终 `agent_message`。

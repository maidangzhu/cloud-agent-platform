# ADR-0009：Provider 防腐层 —— fallback/retry/超时/reasoning 归一收敛于 LLM Proxy

**状态：** 已接受（2026-07-02）

## 决策

所有 provider 的不稳定性与协议差异，收敛在 Control Plane 的 **LLM Proxy（防腐层 / Anti-Corruption Layer）** 一处消化。业务层只依赖一个稳定接口（`complete(messages) → response`），永远不 import 任何具体 provider。

调用链，每层只干一件事：

```
业务层（agent loop / runner）
   |  只说："给我这段对话的下一步" —— 不知道 provider 是谁
   v
LLM Proxy 统一入口（Control Plane）
   |  仅在此处理：
   |   - provider 选择（model → 哪个中转站 / baseURL）
   |   - fallback 链（A 挂 → B → C，顺序在配置里）
   |   - retry（指数退避）
   |   - fail-fast 超时（超了立刻走 fallback 或报错，绝不让上层无限等）
   |   - reasoning / tool 字段归一化
   |   - 记 usage
   v
provider adapter（每中转站一个薄适配器，把各家协议归一成同一接口）
```

## 三条纪律

1. **业务层只依赖稳定接口**，不 import 具体 provider。上层的优雅来自下层承担脏活。
2. **fallback/retry/超时 全部收敛在此层，且配置驱动而非代码驱动。** 换中转站 = 改配置（`providers: [A, B, C]`），不是加 if。治"来回切换来回打"的痛。
3. **fail-fast 超时是关键且易被忽略的一环。** 中转站 hang 住时若无硬超时就会干等——这是 v1 "卡在等 LLM" 病根的一半。PRD 非功能需求"LLM 首响应超时会 retry 或 fail fast"落实于此。

## reasoning 归一化

各家模型号称 OpenAI 兼容，但 reasoning 字段不一（`reasoning` / `reasoning_content` / split reason 等）。adapter 必须把差异归一成系统内部统一表示（对齐 AG-UI 的 reasoning/thinking 事件，见 [ADR-0010](./0010-frontend-agui-protocol.md)）。

**实现选项：** 沙箱 runner 侧可用 Vercel AI SDK 解析模型的 reasoning/tool 流并归一化（前端不用 AI SDK 的 `useChat`，但 runner 侧解析是允许的）。两端都用标准，中间不手写各家协议差异。

## 原则

**所有不稳定性（provider 会挂、会慢、协议不一）隔离在一个防腐层里，用配置驱动的 fallback + fail-fast 超时消化，让业务层面对一个永远稳定、永远统一的接口。**

## 背景

v1 provider 层改了多版，功能补上了但分层不优雅：retry/fallback/换 key/换中转站逻辑漏进业务代码，上层被迫知道下层有几个 provider。用户直觉"底层统一处理、上层不用管"即防腐层模式。

memory 已定："只用 openai-completions 协议 + 自定义 baseURL"，方向保持。之前"装一堆 key 轮换"是坏味道（若为绕 rate limit 则是 hack）；干净设计：一份 provider 配置（`model → provider + baseURL + keyRef`）+ 可选 fallback 链。

## 被否方案

- **fallback/retry 散在业务层：** 上层耦合下层数量与故障，不可维护。
- **多 provider 大工厂：** 过度设计，P0 不需要。
- **provider key 放沙箱：** 见 [ADR-0001](./0001-execution-model.md)，沙箱不持长期凭证；key 留 Control Plane，沙箱走 proxy。同理 search key 走 search proxy。

# ADR-0015：Credit 改为用量遥测；后端工程缺口优先级拍板

**状态：** 已接受（2026-07-03）

## 决策

### 1. Credit 账本改为用量遥测（Usage Telemetry），不做强制执行

原 `CreditLedger`/`CreditBalance`（[data-model.md](../data-model.md) 3.15/3.16）设计的是**强制执行机制**：reserve → debit → refund，余额不够拒绝启动 run。这套机制被否——本项目单人 dogfooding、LLM 调用成本自己承担，没有"额度耗尽必须拒绝"的真实场景，做这套执行逻辑是无场景支撑的装饰性复杂度。

替代为**观测记录机制**：每次 LLM 调用后，记一条用量记录，字段至少包含：

```text
runId
provider（走的哪个渠道/供应商）
model
promptTokens / completionTokens / totalTokens
ttfbMs（首字节耗时）
durationMs（总耗时）
cost（可选，按 provider 定价折算，纯展示用，不做扣费判断）
createdAt
```

用途是纯粹给自己复盘："这次调研花了多少 token、走的哪个 provider、慢在哪一步"，不产生任何"拒绝执行"的业务后果。

数据模型上：可以复用 `CreditLedger` 的表结构改名为 `LLMUsageRecord`（不再叫 credit，因为不再是"钱"或"额度"的概念），去掉 `reserve`/`debit`/`refund` 类型和"余额不能小于 0"的不变量，只保留 append-only 写入 + 按 runId/provider/model 查询。

### 2. Revision 原子性：只保证不卡死，不追求强一致

[ADR-0014](./0014-pre-run-file-sync.md) 的 `revision` 递增，要求是"调用不会卡"，不是"绝对不会出现并发下的短暂不一致"。做法：用数据库原子操作（如 Postgres `UPDATE ... SET revision = revision + 1 RETURNING revision`，或专用 `SEQUENCE`）一步拿号，不做"先查询当前值、再加一、再写回"的两步式应用层逻辑——后者在并发下才会导致重复发号和调用方互相等待/重试。一步原子操作本身不会阻塞调用方（数据库内部处理并发写入是标准能力，不需要额外加锁或重试逻辑）。

不做的事：不引入分布式锁、不引入重试退避策略、不追求"两次并发编辑谁的修改保留"这类语义正确性——当前场景（单人使用、编辑冲突概率低）不需要为此增加复杂度。

### 3. Sweep：确认为刚需，扩大扫的范围到孤儿资源，不只是孤儿 run

[ADR-0008](./0008-sweep-safety-net.md) 原范围是"扫 heartbeat 过期的非终态 run"。确认这条不变量本身是刚需，不动摇。

扩大 sweep 职责范围：定时任务（Vercel Cron）除了收敛卡住的 run，还要清理**孤儿沙箱**——`SandboxInstance` 记录长期 `warm`/`ready` 但已经没有活跃 run 在用、或者对应 run 早已终态但 `SandboxInstance` 状态没跟着收敛的情况。这类孤儿沙箱如果不清理，会产生 Vercel Sandbox 计费的持续成本（占用即计费）和状态表里的僵尸记录（后续排查问题时的噪音）。

Sweep 触发频率沿用 ADR-0008 已定的"每分钟量级收敛 run"；孤儿沙箱清理可以是同一个 sweep job 的一部分，或独立的、频率更低的一个 job（如每日），取决于沙箱空闲计费的实际成本敏感度，具体频率留给实现阶段按 Vercel Sandbox 计费规则决定。

### 4. Serverless 连接池：明确推后，不是遗漏

Vercel serverless 函数 + Postgres 连接数瓶颈（每个函数实例可能各开一条连接，并发上来时容易打满数据库连接上限）是真实存在的架构摩擦点，但当前用户量级下没有触发条件。明确标记为**已知、暂不处理**，不是没想到。触发条件：并发请求量级导致 Postgres 报 "too many connections" 或类似错误。届时标准解法是接入连接池代理（PgBouncer 或托管 Postgres 自带的 pooler 模式，如 Neon pooler）。

## 背景

用户确认 credit 系统"没有真实场景撑着"——追问后发现，真正需要的是给自己看的 LLM 调用审计（token 用量、首字节延迟、走哪个渠道、调用量），不是强制执行的额度管理。这与 [ADR-0005](./0005-single-tenant-enterprise-quality.md) 已经定的"可观测性优先于计费"的方向一致——ADR-0005 早就把"可观测性/eval/看板"列为 P1 但要求 P0 预留字段，本 ADR 是把这个方向具体落到 credit 系统的替代方案上。

同时借这次机会，对几个此前只是"标记为缺口、没有优先级"的后端问题（revision 原子性、连接池、sweep 范围）做一次拍板，避免它们继续以"待办"状态挂着不被处理。

## 被否方案

- **保留 credit 账本原样（reserve/debit/refund），只是不在 UI 强制拒绝：** 保留一套没有真实业务场景驱动的状态机和不变量（"余额不能小于 0"）没有意义，且徒增测试和实现负担（见 [testing-strategy.md](../testing-strategy.md) 4.11 Credits 测试矩阵，这些测试要跟着改）。
- **revision 原子性上分布式锁/重试退避：** 当前并发规模和使用模式（单人、低频编辑）不需要这个复杂度，属于过度设计。
- **连接池现在就做：** 无触发条件的预防性工程投入，且会分散当前更紧迫的问题（P0 核心 agent loop 尚未跑通）的注意力。

## 连锁影响

- **data-model.md**：`CreditLedger`/`CreditBalance` 改为 `LLMUsageRecord`（或类似命名），移除 reserve/debit/refund 语义，移除"余额不能小于 0"不变量。
- **testing-strategy.md** 4.11：Credits 测试矩阵需要重写为"用量记录准确性"测试（如"LLM 调用后记录 token/耗时/provider"），移除 reserve/debit/refund 相关的幂等和余额测试。
- **agent-runtime-protocol.md** 第 9 节：LLM Proxy 契约里"Control Plane 记录 usage"这句已经隐含支持本 ADR，不需要改协议本身，只需要落实数据模型。
- **ADR-0008**：sweep 职责范围扩大到孤儿沙箱清理，需要在该 ADR 或 state-machines.md 里补充 `SandboxInstance` 的收敛策略（目前只写了 Run 的收敛策略）。
- **design-system.md** 13 节"Credits"（可见余额、低余额提示、run 完成后费用）：这一节的产品前提改变了，需要重写或移除——不再有"余额不足拒绝启动 run"的错误状态，改为"这次调研花了多少/用了什么"的展示性信息，可能挪到 artifact 或 run detail 里作为审计信息，而不是常驻 UI 元素。

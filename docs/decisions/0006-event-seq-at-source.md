# ADR-0006：事件 seq 由沙箱源头分配，消费者按 (runId, seq) 幂等

**状态：** 已接受（2026-07-02）

## 决策

- **seq 由沙箱（agent，run 内唯一事件源）在产生事件那一刻分配**，随消息一起传播。**不**由数据库 autoincrement 在落库时分配。
- 消费者/ingest 落库时按 `unique(runId, seq)` 判定：
  - 已存在且 **body 完全一致** → 队列重投的同一条，**当成功、跳过、ACK**（幂等）。
  - 已存在但 **body 不同** → 真 bug（两条不同事件抢同一编号），报 `INGEST_SEQ_CONFLICT`（2004）。

## 背景

引入队列（[ADR-0004](./0004-ingest-queue.md)）后，消费者可能并行消费、乱序落库、重复消费（at-least-once 语义几乎必然重复）。这威胁两条既有硬规矩：①`seq` 在一个 run 内严格单调递增；②`unique(runId, seq)`。

**若落库时才分配 seq：** 队列乱序 → 编号乱 → `file_written` 可能编号早于 `tool_started`，state-machines §9 的偏序（`tool_call_started < tool_call_completed`）当场崩溃。**与队列不能共存。**

**若源头分配 seq：** seq = 事实发生的顺序，随消息走，不依赖落库顺序。乱序落库无所谓，UI/查询一律按 seq 排序 → 永远正确。**与队列天然共存。**

这也解释了 api-contract 中 `IngestEventRequest.seq` 为何是沙箱上报字段——既有设计已正确，本 ADR 补充其必然性。

## 原则

**事件溯源 + 队列的系统里，序号必须在事件源头分配、随消息传播，消费端只认 (源, seq) 做幂等。绝不让序号依赖落库顺序——队列不保证顺序，只保证"至少到一次"。**

## 被否方案

- **DB autoincrement 分配 seq：** 与乱序队列不兼容，破坏偏序。
- **消费者撞 unique 就报错重试：** at-least-once 下重复是常态，报错会导致无限重试；必须幂等跳过。

## 连锁影响

- 与 state-machines.md §9「Ingest Event Ordering」一致，本 ADR 是其底层依据。
- 消费者必须实现"先比 body 再决定幂等/冲突"的逻辑。

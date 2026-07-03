# ADR-0001：执行模型采用 Agent-in-Sandbox（点火器 + 收信箱）

**状态：** 已接受（2026-07-02）

## 决策

Agent loop 运行在 sandbox 内的 runner 进程中。Control Plane（Vercel 函数）只做两件事：

1. **点火** —— 创建/复用 sandbox、启动 runner、签发 scoped run token，几秒内返回。
2. **收信箱** —— 被动接收 runner 通过 ingest API 回报的持久化事实。

Control Plane **不拥有** run 的执行，只拥有 run 的**记录**。

比喻：Control Plane 是发射塔，sandbox 里的 runner 是火箭。发射塔点火后即可下班，火箭自己飞行，途中通过无线电（ingest API）回报状态。地面站只被动收报文，不操控火箭。

## 背景

目标部署形态是 Vercel serverless。Serverless 函数无常驻进程、单次执行上限约 300s，无法在函数内陪跑 30min 的 run。Sandbox 作为独立 microVM，其生命周期不受点火函数关闭影响，可承载长时执行。

## 被否方案

- **模型 B（长命 worker）：** loop 跑在一台常驻进程里，反复 call sandbox 执行工具。否决理由：放弃纯 serverless，增加一块独立运维；当前定位为个人研究工作区，不值得为此养常驻基础设施。
- **模型 C（loop 在 server 函数内，v1 老模型）：** 函数活不过 5min，直接与 30min run 冲突。

## 头号待验证假设

Vercel Sandbox 单实例最长存活时长必须 ≥ run 最大时长（当前 PRD 定 30min）。若实测撑不到，须下调 run 上限或引入续期/快照机制（见 [ADR-0003](./0003-sandbox-snapshot-vs-source-of-truth.md)）。

## 连锁影响

- Control Plane 对 run 内部完全"盲"——只能靠 heartbeat + sweep 推断存活（见 [ADR-0008](./0008-sweep-safety-net.md)）。
- "warm 复用"的语义需重新定义（见 [ADR-0003](./0003-sandbox-snapshot-vs-source-of-truth.md)）。
- 计算负载横向摊到 N 个独立 VM，Control Plane 退化为瘦控制面，瓶颈是写入吞吐而非算力（见 [ADR-0004](./0004-ingest-queue.md)）。

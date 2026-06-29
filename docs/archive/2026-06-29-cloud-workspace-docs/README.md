# Cloud Workspace — 文档索引

> **范式**：Cloud Workspace + Agent-in-Sandbox + Workspace-scoped Memory/Skills
> **生效日期**：2026-06-28
> **事实源**：Postgres（Neon）
> **信任边界**：sandbox 边缘

## 入口

- [PRD](prd.md) — 产品需求
- [Architecture](architecture.md) — 系统架构
- [Data Model](data-model.md) — DB schema
- [API Contract](api-contract.md) — REST/SSE 契约
- [P0 Evolution Plan](p0-evolution-plan.md) — P0 收口、OpenSpec 归档与最小演进路线
- [Glossary](glossary.md) — 核心术语表
- [ADR](adr/) — 架构决策记录

## 当前阅读顺序

如果目标是“面试能讲清楚”，先按这个顺序读：

1. [P0 Evolution Plan](p0-evolution-plan.md)
2. [Glossary](glossary.md)
3. [Architecture](architecture.md)
4. [ADR-0001](adr/0001-trust-boundary-and-agent-in-sandbox.md)
5. [ADR-0007](adr/0007-run-cancel-and-timeout.md)

## ADR 索引

按依赖顺序阅读：

1. [ADR-0001](adr/0001-trust-boundary-and-agent-in-sandbox.md) — 信任边界 + Agent-in-Sandbox
2. [ADR-0002](adr/0002-outbox-sync-protocol.md) — Outbox + Ingest + Ack 同步协议
3. [ADR-0003](adr/0003-workspace-sandbox-lifecycle.md) — Sandbox 生命周期（warm / freeze / thaw）
4. [ADR-0004](adr/0004-workspace-memory-and-skill.md) — Memory / Skill 资产
5. [ADR-0005](adr/0005-ui-three-pane-and-realtime.md) — UI 三栏 + 实时同步
6. [ADR-0006](adr/0006-multi-tenant-and-permission.md) — 多租户与权限
7. [ADR-0007](adr/0007-run-cancel-and-timeout.md) — Run 取消 / 超时 / 孤儿回收

## 归档

2026-06-28 之前的设计已归档到 [archive/](archive/)：

- `archive/adr/0001-sandbox-as-tool.md` 等 5 个旧 ADR
- `archive/sandbox-research.md` 旧调研

不再维护，仅作历史参考。

## 核心不变量

1. **Postgres 是事实源**
2. **Sandbox 不可信**（不持 DB/Redis 凭证，只有 scoped run token）
3. **所有状态变化先成 event**（sandbox 内走 outbox + ingest）
4. **DB 单一写入路径**（agent_events / tool_calls 只有 ingest API 写）
5. **超时兜底**（任何 run 30min 内必有终态）
6. **跨 org 一律 404**（不暴露存在性）

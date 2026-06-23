# Cloud Agent Platform

一个云端自主 Agent 运行平台。用户提交一段自然语言任务（例如「读取这个仓库、找出所有 TODO、生成一份报告」），平台启动一个自主 agent，在隔离的沙箱环境中调用 LLM 推理、调用工具（执行命令、读写文件）、循环迭代直至完成，并返回结构化报告。

> 本项目是一个聚焦核心执行链路的 MVP：`prompt → 创建 run → 初始化 workspace → agent 调用工具 → 事件落库 → 最终报告`。重点在于证明对云端 Agent 平台三个核心边界的理解：**控制面、agent 运行时、沙箱 workspace**。
>
> 架构参考了 Vercel Open Agents (MIT) 这类生产级方案，并基于 Pi (MIT) agent runtime 构建，但实现了一个更小的、任务收束的版本。

## 核心设计主张

严格区分三类状态边界：

1. **控制面状态**（Run / Event / ToolCall / Artifact / Workspace）→ Postgres，平台唯一事实源。
2. **执行状态**（文件、命令输出）→ 沙箱文件系统。
3. **运行时状态**（agent transcript）→ adapter 细节，不作为事实源。

> LLM 是规划器，不是无边界执行器。所有副作用必须经过：工具 schema 校验 → policy guard → 沙箱执行 → 事件落库。

## 技术栈

- **Web / API / 控制面**：Next.js 16 App Router
- **Agent Runtime**：Pi (`@earendil-works/pi-agent-core` + `pi-ai`)
- **LLM**：OpenAI / Anthropic（无 key 时回退 faux provider）
- **沙箱**：统一 `Sandbox` 接口 + 双实现（本地临时目录 / Vercel Firecracker microVM）
- **数据库**：Neon Postgres + Prisma
- **测试**：Vitest
- **部署**：Vercel + Neon

## 开发方式（重要）

本项目采用规范驱动 + 分阶段 + TDD 的开发方式，详见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)：

1. **分阶段交付**：每完成一个阶段就停下，等人工检查通过再继续。
2. **OpenSpec 记录进度**：变更规格与任务清单在 `openspec/changes/cloud-agent-platform-mvp/`。
3. **全程 TDD**：先写测试 → 实现 → 跑绿；测试零外部依赖（faux LLM + 本地沙箱）。
4. **零隐私信息**：仓库内不含任何个人/公司隐私信息。

查看当前进度：

```bash
npx @fission-ai/openspec status --change cloud-agent-platform-mvp
```

## 运行方式

> MVP 开发中，运行说明将随阶段推进补全。

```bash
pnpm install
pnpm dev
```

## 文档

- [`docs/prd.md`](./docs/prd.md) — 产品需求文档（目标、对象、状态流转、范围、验收 benchmark）
- [`docs/architecture.md`](./docs/architecture.md) — 技术方案（三状态边界、选型、agent loop、沙箱、恢复策略、演进、测试）
- [`docs/data-model.md`](./docs/data-model.md) — 数据模型（P0 五表完整字段、事件类型、与 Open Agents 表对照、P1 演进）
- [`docs/sandbox-research.md`](./docs/sandbox-research.md) — Vercel Sandbox 方案调研（SDK API、认证、限制定价、接口设计、安全、落地计划）
- [`docs/adr/0001-sandbox-as-tool.md`](./docs/adr/0001-sandbox-as-tool.md) — 架构决策：Sandbox as Tool vs Agent in Sandbox，为何 P0 选前者
- [`docs/adr/0002-multi-turn-session.md`](./docs/adr/0002-multi-turn-session.md) — 架构决策：多轮会话模型（Session + Message）与 workspace 会话内持久（跨请求、跨沙箱实例）
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — 开发约定（分阶段 / OpenSpec / TDD / 零隐私）

## 项目结构

```
docs/prd.md                                  # 产品需求文档
docs/architecture.md                         # 技术方案
docs/data-model.md                           # 数据模型
openspec/changes/cloud-agent-platform-mvp/   # 规格驱动开发：proposal / design / specs / tasks
src/server/                                  # 控制面、沙箱、工具、agent 编排（开发中）
src/app/                                     # Next.js 页面与 API 路由
```

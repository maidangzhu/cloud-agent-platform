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
- **LLM**：pi-ai，仅 OpenAI 兼容协议（自定义 `baseURL` 指向中转站；需配置 `OPENAI_API_KEY`）
- **沙箱**：统一 `Sandbox` 接口 + VercelSandbox 实现（Firecracker microVM）
- **数据库**：Neon Postgres + Prisma
- **测试**：Vitest
- **部署**：Vercel + Neon

## 开发方式（重要）

本项目采用规范驱动 + 分阶段 + TDD 的开发方式，详见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)：

1. **分阶段交付**：每完成一个任务就停下，等人工检查通过再继续。
2. **OpenSpec 记录进度**：v2 变更规格与任务清单在 `openspec/changes/v2-research-workspace-agent/`（v1 已归档于 `openspec/changes/archive/`）。
3. **全程 TDD**：先写测试 → 实现 → 跑绿。纯逻辑单元测试离线；业务测试连真实 Vercel 沙箱 + Neon + 真实 LLM，后端全绿才开前端。
4. **零隐私信息**：仓库内不含任何个人/公司隐私信息。

查看当前进度：

```bash
npx @fission-ai/openspec status --change v2-research-workspace-agent
```

## 运行方式

> MVP 开发中，运行说明将随阶段推进补全。

```bash
pnpm install
pnpm dev
```

`pnpm dev` 会同时启动：

- `@cap/api`：Hono Control Plane，默认 `http://localhost:8787`
- `@cap/web`：Next.js 前端，默认 `http://localhost:3000`

前端的 `/api/*` 会通过 `apps/web/next.config.ts` rewrite 到本地 API，
浏览器只访问 `localhost:3000`，避免本地跨域 cookie 问题。

## 文档

- [`docs/prd.md`](./docs/prd.md) — 产品需求文档（目标、对象、状态流转、范围、验收 benchmark）
- [`docs/research-agent-tdd-roadmap.md`](./docs/research-agent-tdd-roadmap.md) — Research Workspace Agent 重构路线（agent-in-sandbox、workspace/artifact、Better Auth、点数、API-first TDD）
- [`docs/glossary.md`](./docs/glossary.md) — v2 统一名词表（Workspace / Thread / Run / Artifact / Source / Credit 等）
- [`docs/backend-domain-model.md`](./docs/backend-domain-model.md) — 后端领域模型（对象关系、所有权、服务边界、不变量）
- [`docs/data-model.md`](./docs/data-model.md) — v2 数据模型规格（表、字段、索引、约束、迁移说明）
- [`docs/api-contract.md`](./docs/api-contract.md) — API 契约（响应信封、错误码、DTO、权限、ingest/LLM proxy）
- [`docs/state-machines.md`](./docs/state-machines.md) — 状态机规格（Run、Workspace、Thread、Sandbox、ToolCall、Artifact、Credits、事件顺序）
- [`docs/agent-runtime-protocol.md`](./docs/agent-runtime-protocol.md) — agent-in-sandbox 协议（runner 启动、ingest、tool、LLM proxy、cancel/timeout）
- [`docs/testing-strategy.md`](./docs/testing-strategy.md) — API-first TDD 测试策略（单元、路由、集成、fake runner、失败矩阵）
- [`docs/frontend-vercel-chatbot-reference.md`](./docs/frontend-vercel-chatbot-reference.md) — 前端参考落地方案（Vercel Chatbot 风格、artifact 面板、SSE/API 适配、TDD）
- [`docs/design-system.md`](./docs/design-system.md) — 产品设计规范（布局、视觉、artifact、文件/source、响应式、无障碍、测试清单）
- [`docs/technical-design.md`](./docs/technical-design.md) — v1 技术设计参考（实现 v2 时以新规格文档为准）
- [`docs/implementation-roadmap.md`](./docs/implementation-roadmap.md) — v2 逐步执行路线图（21 Group / 45 Step，每步含代码任务/测试断言/验收标准/所需 env 变量）
- [`docs/decisions/`](./docs/decisions/) — 架构决策记录（ADR-0001~0022），每条含决策内容/背景/被否方案/连锁影响
- [`openspec/changes/v2-research-workspace-agent/`](./openspec/changes/v2-research-workspace-agent/) — v2 OpenSpec 规格（proposal / design / specs / tasks，tasks 与 implementation-roadmap 的 Group/Step 一一对应）
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — 开发约定（分阶段 / OpenSpec / TDD / 零隐私）

## 项目结构

```
docs/prd.md                                  # 产品需求文档
docs/research-agent-tdd-roadmap.md           # v2 分阶段路线
docs/glossary.md                             # v2 统一名词
docs/backend-domain-model.md                 # v2 后端领域模型
docs/data-model.md                           # v2 数据模型
docs/api-contract.md                         # v2 API 契约
docs/state-machines.md                       # v2 状态机
docs/agent-runtime-protocol.md               # v2 agent-in-sandbox 协议
docs/testing-strategy.md                     # v2 API-first TDD 策略
docs/design-system.md                        # v2 产品设计规范
docs/frontend-vercel-chatbot-reference.md    # v2 前端参考落地
docs/implementation-roadmap.md               # v2 逐步执行路线图（21 Group / 45 Step）
docs/decisions/                              # ADR-0001~0022 架构决策记录
openspec/changes/v2-research-workspace-agent/# v2 规格驱动开发：proposal / design / specs / tasks
openspec/changes/archive/                    # v1（cloud-agent-platform-mvp）归档
apps/web/                                    # v2 Next.js 前端
apps/api/                                    # v2 Hono Control Plane
packages/db/                                 # v2 Prisma schema + client（monorepo）
packages/shared/                             # v2 前后端共享 DTO/schema（monorepo）
```

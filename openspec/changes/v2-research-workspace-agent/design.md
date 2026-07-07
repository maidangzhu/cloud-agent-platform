## Context

v2 的完整架构论证已经在 `docs/decisions/`（ADR-0001~0022）逐条记录——每条 ADR 都包含决策内容、背景、被否方案、连锁影响。本文档**不重复那些论证**，只做三件事：（1）汇总关键决策的落地形态供实现时速查，（2）列出跨 capability 的风险和缓解方式，（3）给出迁移顺序。要理解"为什么这么定"，去读对应的 ADR 链接；要理解"具体做什么"，看 specs/ 和 tasks.md。

当前状态：v1（`cloud-agent-platform-mvp`）已归档，v2 已迁入 monorepo：`apps/web` 承载 Next.js 前端，`apps/api` 承载 Hono Control Plane，`packages/db` 承载 Prisma schema + client。旧根 `src/` 应被视为已废弃并删除；需要复用的沙箱封装已迁到 `apps/api/src/sandbox/`。

## Goals / Non-Goals

**Goals：**

- 把 ADR-0001~0022 的决策转译为可通过 `openspec status`/`openspec validate` 追踪的 spec + task 结构。
- 保证 monorepo 迁移（ADR-0022）不破坏 v1 已验证可用的沙箱/LLM 集成代码，采用渐进迁移而非重写。
- 保证 Run 状态机的原子性原则（ADR-0018）在第一次真正接入数据库时就落地，不留"先查后改"的技术债。

**Non-Goals：**

- 不在本变更内重新论证已经拍板的 ADR 内容；如需推翻某条 ADR，先补一条新 ADR 再回来改本变更。
- 不追求 P0 阶段就实现多人协作、组织/团队、完整文件版本历史等（见 `docs/backend-domain-model.md` §6 P0 非目标）。
- 不在 P0 做 GUI/OS 级行为验证（ADR-0013 已明确这是架构性做不到，非排期问题）。

## Decisions

以下每条决策只给落地形态，完整论证见括号内链接。

| 决策 | 落地形态 | 详细论证 |
|---|---|---|
| Run 状态转移原子性 | 唯一入口 `transitionRun(runId, toStatus, fromStatuses[])`，内部条件 UPDATE，禁止 check-then-act | [ADR-0018](../../../docs/decisions/0018-atomic-state-transitions.md) |
| waiting_for_input | 新增非终态 RunStatus；不做 resume 同一进程，sandbox 正常退出，用户回答=创建新 run + 原子转旧 run 为 completed；sweep 7 天阈值兜底 | [ADR-0019](../../../docs/decisions/0019-waiting-for-input-state.md) |
| Event payload schema | `AgentEventPayloadMap` 判别联合，按 `type` 校验形状；thinking/content 与 tool_call 字段互斥 | [ADR-0020](../../../docs/decisions/0020-agent-event-payload-schema-and-tool-retry.md) |
| Token 转发 | Redis Streams（`XADD`/`XREAD`）+ cursor，取代 Pub/Sub；`Last-Event-ID` 映射为续读 cursor | [ADR-0021](../../../docs/decisions/0021-token-stream-relay-redis-streams.md)（修正 [ADR-0016](../../../docs/decisions/0016-token-stream-relay-redis-pubsub.md)） |
| 后端框架/项目结构 | Hono（`apps/api`，Vercel Serverless）+ Next.js（`apps/web`）+ pnpm workspaces（无 Turborepo）；Better Auth 挂 `apps/api` | [ADR-0022](../../../docs/decisions/0022-monorepo-hono-backend.md) |
| Credit → 用量遥测 | `LLMUsageRecord` 替代 `CreditLedger`/`CreditBalance`，无 reserve/debit/refund，无余额拒绝路径 | [ADR-0015](../../../docs/decisions/0015-usage-telemetry-and-ops-priorities.md) |
| Search proxy + 工具重试 | `POST /api/search-proxy`（5xx 重试 2 次，4xx 不重试）；`fetch_url` SSRF guard + 1 次重试，SSRF 触发判 rejected 非 failed | [ADR-0020](../../../docs/decisions/0020-agent-event-payload-schema-and-tool-retry.md) |
| Artifact 版本化 | `artifactId` 已存在 → version+1 + `artifact_updated`；不存在 → version=1 + `artifact_created` | [ADR-0020](../../../docs/decisions/0020-agent-event-payload-schema-and-tool-retry.md) |
| Sandbox 复用互斥 | `SandboxInstance.currentRunId` 原子认领（`WHERE ... AND current_run_id IS NULL`） | [ADR-0018](../../../docs/decisions/0018-atomic-state-transitions.md) |
| Sweep 范围 | 扩大到孤儿 SandboxInstance + 过期 Redis stream key，不只是卡死的 run | [ADR-0015](../../../docs/decisions/0015-usage-telemetry-and-ops-priorities.md) |

完整接口契约见 `docs/api-contract.md`；数据模型见 `docs/data-model.md`；状态机见 `docs/state-machines.md`。

## Risks / Trade-offs

- **[风险] Monorepo 迁移期间 v1 现有测试可能暂时性中断** → 缓解：`docs/implementation-roadmap.md` 的 Group 2 拆成 4 个小 Step，每步验证 `pnpm test`/`pnpm build` 不受影响后才停下确认，不做大爆炸式迁移。
- **[风险] Redis 作为新增外部依赖，Upstash 服务不可用会影响 token 实时流** → 缓解：Redis 转发路径全程不落库（ADR-0011/0016），Redis 故障时业务事实（tool_call/file/artifact/终态）仍走独立的 ingest 可靠通道，只是 token 级实时体验降级，不影响正确性。
- **[风险] Hono 迁移期间 Better Auth session cookie 跨域（本地开发 `apps/web:3000` vs `apps/api:8787`）** → 缓解：`apps/web` 的 `next.config.ts` rewrite 代理 `/api/*` 到本地 Hono 端口，浏览器视角只有一个 origin（ADR-0022）。
- **[风险] `transitionRun` 原子 UPDATE 如果被某个调用点绕过，等于白做** → 缓解：测试矩阵（`docs/testing-strategy.md` §4.4）显式包含"并发调用只有一次生效"的断言，作为回归防线；代码 review 时检查是否有裸露的 `db.run.update` 调用。
- **[Trade-off] 不做 consumer group，多 tab 查看同一个 run 各自独立 `XREAD`** → 接受：当前单人使用场景下多 tab 并发量极低，consumer group 的 ack/重新分配机制是不必要的复杂度（ADR-0021）。

## Migration Plan

按 `docs/implementation-roadmap.md` 的 21 个 Group 顺序执行，每个 Group 对应本变更 tasks.md 的一个任务分组：

1. Monorepo 脚手架（Group 2）→ 2. Auth（Group 3）→ 3. Workspace/Thread（Group 4-5）→ 4. Run 状态机 + Event Store（Group 6，ADR-0018/0019 核心落地）→ 5. Scoped Token + Ingest 基线（Group 7-8）→ 6. Fake Runner（Group 9）→ 7. Files/Artifacts/Sources（Group 10-12）→ 8. Token Stream 转发（Group 13，ADR-0021）→ 9. LLM Proxy（Group 14）→ 10. Search Proxy + 工具协议（Group 15，ADR-0020）→ 11. 真实 Agent Loop（Group 16）→ 12. Usage 遥测（Group 17）→ 13. Sweep（Group 18）→ 14. UI（Group 19）→ 15. E2E（Group 20）→ 16. 部署（Group 21）。

每步做完停下确认，不连续推进多个 Step（见 `docs/implementation-roadmap.md` 开头的使用规则）。回滚策略：Group 2 阶段 v1 代码原地不动，可随时放弃 monorepo 迁移回到纯 Next.js 结构；Group 3 之后的回滚需要具体到当时的 git commit，因为数据库 schema 会开始演进。

## Open Questions

无——DQ-1/DQ-2/DQ-3 均已解决（见 `docs/decisions/OPEN-QUESTIONS.md`）。DQ-4（AgentEventDTO 是否对齐 AG-UI schema）仍待前端开工前定，届时在 Group 19（UI Shell）开始时补充决策。

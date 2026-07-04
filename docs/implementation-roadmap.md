# 实现路线图 — 逐步执行 + 每步停下确认

这份文档取代 [research-agent-tdd-roadmap.md](./research-agent-tdd-roadmap.md) 里过时的 Phase 划分（那份文档的 Phase 粒度太粗，且没吃进 [ADR-0018~0022](./decisions/README.md)）。本文档的粒度是"一步能在一次对话里做完并验证"，不是"一整块功能"。

## 使用规则

- 每个 Step 写清楚：要写什么代码、要写多少、怎么测、验收标准、要不要用户补 env、做完在哪里停下来确认。
- **每个 Step 做完必须停下来，等用户明确确认后才进入下一个 Step。** 不允许因为"看起来很清楚"就连续做完多个 Step 不停顿。
- 每个 Step 都必须有对应的自动化测试（PoC 类步骤除外，PoC 用手动跑脚本验证，不计入正式测试套件）。
- 测试用例的具体断言清单见 [testing-strategy.md](./testing-strategy.md) §4（按领域标注了序号，Step 执行时按需引用对应编号，不重复罗列）。
- 涉及数据库/沙箱/Redis 的步骤，优先用 fake/mock 让默认 `pnpm test` 保持零外部依赖；需要真实外部资源的测试标注为 integration，单独跑。

## 总览：Step 分组

```text
Group 0：PoC（环境连通性）— 已完成
Group 1：文档校订（ADR-0018~0022 + 关联文档修订）— 已完成
Group 2：Monorepo 脚手架（ADR-0022）
Group 3：Auth（Better Auth 挂 apps/api）
Group 4：Workspace
Group 5：Thread
Group 6：Run 状态机 + Event Store（含 ADR-0018/0019）
Group 7：Scoped Run Token
Group 8：Ingest API 基线（含 ADR-0020 payload schema）
Group 9：Fake Sandbox Runner
Group 10：Workspace Files
Group 11：Artifacts（含版本化，ADR-0020）
Group 12：Sources
Group 13：Token Stream 转发（Redis Streams，ADR-0021）
Group 14：LLM Proxy
Group 15：Search Proxy + web_search/fetch_url 工具协议（ADR-0020）
Group 16：真实 Sandbox Agent Loop
Group 17：Usage 遥测（原 Credits，ADR-0015）
Group 18：Sweep（含孤儿资源清理，ADR-0015；waiting_for_input 阈值，ADR-0019）
Group 19：UI Shell
Group 20：Browser E2E
Group 21：部署和运维
```

---

## Group 0：PoC（环境连通性）— 已完成

### Step 0.1：Redis 连通性验证 ✅

已完成。`scripts/poc/redis-ping.ts` 验证了 Upstash Redis 的 SET/GET、XADD/XREAD、cursor 续读。已保留在仓库供以后排障用。

### Step 0.2：Vercel Sandbox 连通性验证 ✅

已完成。`scripts/poc/sandbox-ping.ts` 验证了 v2 分支下现有 `getOrCreateSandbox` 封装仍可用。已保留在仓库供以后排障用。

**用户确认状态：** 两步已完成并确认，`ioredis@5.11.1` 已装入 `package.json`。

---

## Group 1：文档校订 — 已完成

ADR-0018~0022 已落盘，state-machines.md / agent-runtime-protocol.md / api-contract.md / design-system.md / data-model.md / backend-domain-model.md / glossary.md / frontend-vercel-chatbot-reference.md 已修订，decisions/README.md 和 OPEN-QUESTIONS.md 已更新，testing-strategy.md §4 已从提纲改写为约 260+ 条具体测试名清单。

**用户确认状态：** 待本轮对话确认。

---

## Group 2：Monorepo 脚手架（[ADR-0022](./decisions/0022-monorepo-hono-backend.md)）

这是第一个真正改动代码结构的 Group，拆成小步骤，每步独立验证，不一次性搬完。

### Step 2.1：建 pnpm workspace 空壳，不搬任何现有代码 ✅

要写的东西：

- 根目录新增 `pnpm-workspace.yaml`，声明 `apps/*`、`packages/*`。
- 新建 `apps/web/`、`apps/api/`、`packages/shared/`、`packages/db/` 四个空目录，每个先放一个最小 `package.json`（name/version/private，无依赖）。
- 根 `package.json` 的 `workspaces` 相关脚本先不动现有内容，只确认 `pnpm install` 能在新结构下跑通。

怎么测：无自动化测试。手动验证：`pnpm install` 成功，`pnpm -r list`（或等价命令）能看到 4 个新 package。

验收标准：workspace 结构存在，现有 `src/`、`prisma/` 等原有代码**原地不动**，`pnpm test`/`pnpm build`（旧命令）仍然照常跑通，说明这一步没有破坏任何现有功能。

停下来确认：用户看到新目录结构和验证结果后确认，再继续。

### Step 2.2：起一个只有 health check 的 Hono app，验证部署链路 ✅

要写的东西：

- `apps/api/src/index.ts`：一个最小 Hono app，一个 `GET /health` 返回 `{ ok: true }`。
- `apps/api/package.json` 加 `hono` 依赖（锁定具体版本号）和一个本地 dev 脚本（如用 `@hono/node-server` 本地跑，端口用一个不常见值如 `8787` 避免和 Next.js `:3000` 冲突）。
- 暂不接 `@hono/vercel` adapter、暂不部署，先本地跑通。

怎么测：

- Route test（vitest）：`GET /health` 返回 200 和 `{ ok: true }`。这是第一条真正落地的自动化测试，验证 Hono app 本身可测试。

验收标准：`pnpm --filter api test` 通过；本地 `pnpm --filter api dev` 能访问 `http://localhost:8787/health`。

停下来确认：用户本地验证访问到 health check 后确认。

### Step 2.3：迁移 Prisma 到 `packages/db` ✅

要写的东西：

- 把 `prisma/schema.prisma`、`prisma.config.ts` 移到 `packages/db/prisma/`。
- `packages/db/package.json` 加 `@prisma/client`、`@prisma/adapter-pg`、`pg` 依赖，导出一个 `getPrismaClient()` 工厂函数。
- `apps/api` 依赖 `packages/db`（pnpm workspace 内部依赖，`"@cap/db": "workspace:*"` 这种写法，具体包名到时候跟用户确认命名习惯）。

需要用户补的 env 变量：无新增——`DATABASE_URL` 沿用现有 `.env`，只是读取位置从根目录变成 `packages/db` 内部读取（或由 `apps/api` 启动时统一加载根 `.env`，具体机制在这一步确定）。

怎么测：

- 一条 integration test：`packages/db` 能连上测试数据库并执行一次简单查询（复用现有测试数据库配置，不需要新的数据库实例）。

验收标准：`pnpm --filter db build`（如有）或等价验证通过；`apps/api` 能 import `packages/db` 并执行一次查询。

停下来确认：这一步涉及"移动"而不是"新建"，需要用户确认迁移后原 `prisma/` 目录内容如何处理（保留作参考还是删除）——按规矩，删除操作要停下来问，不能自己决定删。

### Step 2.4：本地开发跨域 cookie 代理 ✅

要写的东西：

- `apps/web/next.config.ts` 增加 rewrite：`/api/*` 代理到本地 `apps/api` 端口（[ADR-0022](./decisions/0022-monorepo-hono-backend.md) 已定的默认方案）。

怎么测：手动验证（这一步是纯配置，没有独立单元可测；正确性会在后续 Group 3 Auth 步骤里被间接验证——如果代理配错，auth cookie 测试会失败）。

验收标准：`apps/web` 本地访问 `/api/health` 能拿到 Hono 返回的响应（走 rewrite，不是浏览器直连 `:8787`）。

停下来确认：用户验证后确认。Group 2 完成，Monorepo 骨架就位，下面开始把业务代码逐步迁移/新建到这个骨架里。

---

## Group 3：Auth（Better Auth 挂 `apps/api`）

### Step 3.1：装 Better Auth，接入 Hono ✅

要写的东西：

- `apps/api` 加 `better-auth` 依赖（锁定版本）。
- Better Auth 配置文件，绑定到 `packages/db` 的 Prisma adapter。
- Better Auth 的 schema tables 通过 `pnpm --filter db` 的 migrate 命令生成/追加到现有数据库。

需要用户补的 env 变量：Better Auth 需要的密钥（如 `BETTER_AUTH_SECRET`）——这一步会告知具体变量名，请用户补到 `.env`。

怎么测：

- 按项目规矩（不 mock 数据库/沙箱/Redis），改成真实连 Neon 的集成测试而非 unit test（`apps/api/src/auth.integration.test.ts`），覆盖注册/登录/session 查询/未登录拒绝/错误密码拒绝/重复邮箱拒绝 6 个场景，共 7 条测试，全部真实通过。

验收标准：本地能通过 Better Auth 的 API 完成一次注册/登录（已验证）。

**实测踩坑，后续步骤复用 Prisma/Better Auth 时注意：**

1. **modelName 大小写**：`@better-auth/prisma-adapter` 用 `db[modelName]` 原样取 Prisma 委托属性，委托属性名是小写驼峰（如 `authSession`），配置 `modelName` 时必须写小写开头，不是 Prisma model 声明名（`AuthSession`）的原样大小写。
2. **多份 Prisma schema 共享物理生成目录**：根目录 `prisma/schema.prisma`（v1）和 `packages/db/prisma/schema.prisma`（v2）如果版本号相同且不显式指定 `generator.output`，会写入同一个共享 `.pnpm` 目录，谁后 `generate` 谁覆盖谁——`pnpm build` 会静默抹掉另一份的生成产物。`packages/db` 已加独立 `output` 路径规避，之后任何新增的 Prisma schema 副本都要照此处理。

停下来确认。

### Step 3.2：`GET /api/me` + 受保护路由 helper

要写的东西：

- `apps/api` 的 `requireUser()` helper。
- `GET /api/me` 路由，返回 `MeData`（[api-contract.md](./api-contract.md) §5.1，注意不再包含 credits）。

怎么测：[testing-strategy.md §4.1](./testing-strategy.md#41-auth) route 测试 4-7。

验收标准：未登录 401，已登录返回 user。

停下来确认：这是第一个端到端可验证的真实业务端点，建议用户此时通过浏览器/curl 手动走一次注册→登录→`GET /api/me` 全流程再确认。

---

## Group 4：Workspace

### Step 4.1：Workspace 数据模型 + CRUD 路由

要写的东西：

- `packages/db` 的 `Workspace` 表迁移。
- `apps/api` 的 workspace 路由：`GET/POST /api/workspaces`、`GET/PATCH/DELETE /api/workspaces/:workspaceId`。
- title validation、archive 策略（[state-machines.md](./state-machines.md) §3）。

怎么测：[testing-strategy.md §4.2](./testing-strategy.md#42-workspace) unit 1-5、route 6-15。

验收标准：CRUD 全部通过 API 测试闭环，跨用户访问不可能。

停下来确认。

### Step 4.2：Workspace 归档的原子拒绝（[ADR-0018](./decisions/0018-atomic-state-transitions.md)）

要写的东西：

- 创建 run/thread 时的 insert-select 原子拒绝逻辑（这一步先只搭 workspace 侧，thread/run 表还没建，先写一个针对 workspace 状态检查的独立小函数，为后续 Group 5/6 复用打基础）。

怎么测：[testing-strategy.md §4.2](./testing-strategy.md#42-workspace) integration 16-17（并发竞态测试）。

验收标准：并发下只有一种结果，不会出现"先查后建"的窗口。

停下来确认：这一步是 ADR-0018 原则第一次真正落地为代码，建议用户重点 review 这个原子 UPDATE helper 的实现，因为后续 Group 6（Run 状态机）会大量复用同一个模式。

---

## Group 5：Thread

### Step 5.1：Thread 数据模型 + CRUD 路由

要写的东西：

- `Thread`/`Message` 表迁移。
- `apps/api` 路由：`GET/POST /api/workspaces/:workspaceId/threads`、`GET/PATCH /api/threads/:threadId`。
- title 派生逻辑（无 title 时从 initialPrompt 推导）。

怎么测：[testing-strategy.md §4.3](./testing-strategy.md#43-thread) unit 1-4、route 5-13。

验收标准：CRUD 通过，thread detail 包含 messages 和 runs（runs 暂时是空数组，Group 6 才会有内容）。

停下来确认。

---

## Group 6：Run 状态机 + Event Store（含 [ADR-0018](./decisions/0018-atomic-state-transitions.md)/[ADR-0019](./decisions/0019-waiting-for-input-state.md)）

这是目前为止最重要的 Group——Run 状态机是整个系统的地基，ADR-0018 的原子转移原则要在这里首次完整落地，不是先写"先查后改"的版本再改。拆成 5 个子步骤。

### Step 6.1：RunStatus 纯函数状态机（不接数据库）

要写的东西：

- 一个纯函数模块（无 DB/网络依赖）：`isLegalTransition(from: RunStatus, to: RunStatus): boolean`，覆盖 [state-machines.md](./state-machines.md) §1 全部合法转移（含 `waiting_for_input`）。
- `deriveUiState(status, lastHeartbeatAt, now): DerivedUiState` 纯函数（§2）。

怎么测：[testing-strategy.md §4.4](./testing-strategy.md#44-run) unit 1-11。

验收标准：全部合法/非法转移断言通过，纯函数零外部依赖，`pnpm test` 默认套件覆盖。

停下来确认：这一步产出的两个纯函数是后续所有 Run 相关代码的基础，建议用户过一遍具体转移表实现是否和 state-machines.md 完全对应。

### Step 6.2：`transitionRun` 原子 UPDATE 封装（[ADR-0018](./decisions/0018-atomic-state-transitions.md)）

要写的东西：

- `packages/db`（或 `apps/api` 内部）实现 `transitionRun(runId, toStatus, fromStatuses[]): Promise<{ applied: boolean }>`，内部是条件 UPDATE，返回受影响行数。
- 所有后续状态变更代码只能调这个函数，不允许绕过。

怎么测：[testing-strategy.md §4.4](./testing-strategy.md#44-run) unit 12-14。

验收标准：并发调用只有一次生效，另一次返回 `applied: false` 且不抛错。

停下来确认。

### Step 6.3：Run + AgentEvent 数据模型 + 创建/查询路由

要写的东西：

- `Run`、`AgentEvent`、`ToolCall` 表迁移。
- `POST /api/threads/:threadId/runs`（含 [ADR-0019](./decisions/0019-waiting-for-input-state.md) 的"先转旧 waiting_for_input run 为 completed"逻辑，以及 [ADR-0018](./decisions/0018-atomic-state-transitions.md) 的 workspace/thread 归档原子拒绝，复用 Step 4.2/5.1 的判断逻辑）。
- `GET /api/runs/:runId`、`POST /api/runs/:runId/cancel`。

怎么测：[testing-strategy.md §4.4](./testing-strategy.md#44-run) route 15-22。

验收标准：能创建/查询/取消 run，但此时还没有真实 sandbox，run 会一直停在 `created`（这是预期的，Group 9 才接 fake runner）。

停下来确认。

### Step 6.4：Event Store（ingest 基础，先不connect sandbox）

要写的东西：

- Event 写入逻辑：seq 唯一性、幂等重复检测、[ADR-0020](./decisions/0020-agent-event-payload-schema-and-tool-retry.md) payload schema 校验（先实现 schema 校验函数本身，暂不接 scoped token——Group 7 才加认证层）。
- 测试环境下直接用测试 helper 往 DB 插入事件（不通过真实 HTTP ingest 端点，那是 Group 8 的内容）。

怎么测：[testing-strategy.md §4.5](./testing-strategy.md#45-events) unit 1-9。

验收标准：seq 单调、幂等、payload schema 校验全部通过。

停下来确认。

### Step 6.5：SSE 基础（先用手动插入的事件驱动，不接真实 sandbox）

要写的东西：

- `GET /api/runs/:runId/events` SSE 端点：snapshot + 新事件推送 + done。
- 暂不实现 [ADR-0021](./decisions/0021-token-stream-relay-redis-streams.md) 的 stream-chunk 转发（那是 Group 13），这一步只做"业务事实事件"的 SSE。

怎么测：[testing-strategy.md §4.5](./testing-strategy.md#45-events) SSE 22-25、28。

验收标准：SSE 能推送手动插入的事件，刷新可以从 DB snapshot 恢复。这一步完成后，Run lifecycle 已经不依赖 sandbox 就能被完整验证——对应原 roadmap Phase 5 的验收标准。

停下来确认：这是一个重要里程碑，建议这里做一次稍微完整的手动验证（用测试脚本模拟一个 run 的完整生命周期，肉眼看 SSE 输出），确认后再进入需要真实沙箱的 Group。

---

## Group 7：Scoped Run Token

### Step 7.1：Token 签发与校验

要写的东西：

- Token 签名/解析（先用服务端 secret 签名的无状态 token，[data-model.md](./data-model.md) §3.14 提到的 P0 替代方案，不落库 `RunToken` 表，除非后续发现需要撤销能力）。
- 绑定 userId/workspaceId/threadId/runId/过期时间。

怎么测：[testing-strategy.md §4.4](./testing-strategy.md#44-run)（token 部分并入 events 矩阵）以及独立的 token unit 测试：签发、校验、过期、跨 run/workspace 拒绝。

验收标准：token 不能跨 run 使用，过期后失效。

停下来确认。

---

## Group 8：Ingest API 基线（真正接上认证层）

### Step 8.1：`POST /api/ingest/events` + heartbeat（真实 HTTP 端点）

要写的东西：

- 把 Group 6.4 写好的 Event Store 逻辑包装成真实路由，加上 scoped run token 校验（Group 7）。
- `POST /api/ingest/heartbeat`（含 `phase` 字段，[api-contract.md](./api-contract.md) §6.2）。

怎么测：[testing-strategy.md §4.5](./testing-strategy.md#45-events) route 10-17。

验收标准：测试可以创建 run、签发 token、调 ingest、再通过 `GET /api/runs/:id` 读到 events——不需要真实 sandbox。

停下来确认。

### Step 8.2：`POST /api/ingest/tool-calls`

要写的东西：ToolCall 的 start/completion 记录路由，[state-machines.md](./state-machines.md) §6 状态机的应用（含 `rejected` vs `failed` 区分）。

怎么测：对应 ToolCall 相关 unit/route（并入后续 Group 15 web_search/fetch_url 的具体断言，这一步先验证通用的 tool-call 记录机制本身）。

验收标准：能记录 pending→running→completed/failed/rejected 全部路径。

停下来确认。这个 Group 完成后，对应原 roadmap Phase 7 的验收标准："sandbox 不需要 DB access，Control Plane 只通过 ingest 观察"这条原则在代码层面首次成立。

---

## Group 9：Fake Sandbox Runner

### Step 9.1：Fake runner 骨架（不用真实 Vercel Sandbox，先用本地进程模拟）

要写的东西：

- `testing` helper：一个可配置行为的 fake runner（模式：complete/fail/timeout/cancel-aware/file-write/artifact-create/source-record，[testing-strategy.md §3.3](./testing-strategy.md#33-fake-runner)）。
- fake runner 只通过 ingest HTTP API 和 scoped run token 与系统交互，不直接碰数据库——这条约束本身就是要验证的东西。

怎么测：[testing-strategy.md §4.6](./testing-strategy.md#46-sandbox) integration 6-10。

验收标准：fake runner 能完成一个 run 的完整生命周期（心跳→事件→文件→artifact→终态），全程只用 HTTP。

停下来确认。

### Step 9.2：接入真实 Vercel Sandbox（fake runner 代码跑在真沙箱里）

要写的东西：

- 复用 `src/server/sandbox/factory.ts`（已验证可用，Group 0 PoC 确认过）。
- Control Plane 侧的 sandbox 认领逻辑（[ADR-0018](./decisions/0018-atomic-state-transitions.md) `currentRunId` 原子认领）。
- 把 fake runner 脚本上传到真实沙箱并启动。

怎么测：[testing-strategy.md §4.6](./testing-strategy.md#46-sandbox) integration 3-5、11-14。

验收标准：fake runner 确实在 Vercel Sandbox microVM 里运行（不是本地进程），Control Plane 只能通过 ingest 观察它，SandboxInstance 复用互斥测试通过。

停下来确认：这一步涉及真实计费资源（Vercel Sandbox），建议用户此时关注一下 Vercel 账单/用量，确认测试频率可接受。

---

## Group 10：Workspace Files

### Step 10.1：File ingest + 查询路由

要写的东西：`POST /api/ingest/files`、`GET /api/workspaces/:workspaceId/files`、`GET .../files/content`，path guard、content hash、size policy。

怎么测：[testing-strategy.md §4.7](./testing-strategy.md#47-files) unit 1-4、route 5-12。

验收标准：路径穿越被拒绝，正常文件读写通过。

停下来确认。

### Step 10.2：Fake runner 写文件的端到端验证

要写的东西：把 Group 9 的 fake runner 扩展出 `write_file` 行为，串联 Group 10.1 的 ingest 端点。

怎么测：[testing-strategy.md §4.7](./testing-strategy.md#47-files) integration 13-15。

验收标准：fake runner 写的文件刷新后仍可读（从 DB 而不是从沙箱内存）。

停下来确认。

---

## Group 11：Artifacts（含版本化，[ADR-0020](./decisions/0020-agent-event-payload-schema-and-tool-retry.md)）

### Step 11.1：Artifact ingest + 首次创建

要写的东西：`POST /api/ingest/artifacts`（首次创建路径，version=1）、`GET /api/workspaces/:workspaceId/artifacts`、`GET /api/artifacts/:artifactId`。

怎么测：[testing-strategy.md §4.8](./testing-strategy.md#48-artifacts) unit 1-2、5、route 6、8-9、13-14。

验收标准：能创建并读取 artifact，缺可恢复内容时被拒绝。

停下来确认。

### Step 11.2：Artifact 版本化（`artifact_updated`）+ versions/download 端点

要写的东西：已存在 artifactId 时的版本递增逻辑（原子递增，复用 ADR-0018 原则）、`GET .../versions`、`GET .../download`。

怎么测：[testing-strategy.md §4.8](./testing-strategy.md#48-artifacts) unit 3-4、route 7、10-12、integration 16-17。

验收标准：新版本创建后旧版本仍可读，versions 端点返回完整历史。

停下来确认。

---

## Group 12：Sources

### Step 12.1：Source ingest + 查询

要写的东西：`POST /api/ingest/sources`、`GET /api/workspaces/:workspaceId/sources`、`GET /api/runs/:runId/sources`。

怎么测：[testing-strategy.md §4.9](./testing-strategy.md#49-sources) unit 1-2、route 3-7、integration 8-9。

验收标准：source 能被 artifact 引用，查询正常。

停下来确认。这个 Group 完成后，对应原 roadmap 到 Phase 11 为止的全部内容已经用 fake runner 验证完毕，下一步开始接真实基础设施（Redis token 流、真实 LLM）。

---

## Group 13：Token Stream 转发（Redis Streams，[ADR-0021](./decisions/0021-token-stream-relay-redis-streams.md)）

### Step 13.1：正式的 Redis 客户端封装（区别于 Group 0 的 PoC 脚本）

要写的东西：

- `packages/shared` 或 `apps/api` 内的 Redis 客户端封装：连接管理、错误处理、`XADD`/`XREAD` 的 TS 类型包装。
- `POST /api/ingest/stream-chunk` 路由（内部调 `XADD`，不落库）。

需要用户补的 env 变量：无新增，复用已有 `.env` 里的 `REDIS_URL`。

怎么测：[testing-strategy.md §4.5](./testing-strategy.md#45-events) route 18-21。

验收标准：chunk 能被写入且不产生 AgentEvent 行，写入后立即可读。

停下来确认。

### Step 13.2：SSE 端接入 cursor 续读

要写的东西：`GET /api/runs/:runId/events` 增加"订阅 Redis stream 并按 cursor 转发"这一层，处理 `Last-Event-ID` header。

怎么测：[testing-strategy.md §4.5](./testing-strategy.md#45-events) SSE 26-28。

验收标准：新连接从 stream 起始读取存量 chunk；重连用 `Last-Event-ID` 续读不丢失、不重复——这是 ADR-0021 要解决的核心问题，这一步的测试必须真实模拟"建连竞态"和"重连空洞"两个场景，不能只测 happy path。

停下来确认：这是本轮讨论里技术含量最高的一步，建议用户重点验证这两个竞态场景的测试是否真的覆盖到位。

### Step 13.3：过期 stream 清理（并入 sweep，先占位）

要写的东西：一个清理过期 Redis stream key 的函数（先写函数本身，实际接入 sweep 定时任务在 Group 18）。

怎么测：unit 测试——给定一个"已终态很久"的 run，对应 stream key 被清理。

验收标准：函数本身可测试、幂等（清理不存在的 key 不报错）。

停下来确认。

---

## Group 14：LLM Proxy

### Step 14.1：LLM Proxy 路由 + fake provider

要写的东西：`POST /api/llm-proxy`，先接 fake provider（deterministic 测试用），token/run 状态校验。

怎么测：[testing-strategy.md §4.10](./testing-strategy.md#410-llm-proxy) route 4-9。

验收标准：fake provider 模式下能跑通，terminal run 被拒绝。

停下来确认。

### Step 14.2：真实 provider 接入 + finish_reason 归一化

要写的东西：接入真实 LLM（复用现有 `@earendil-works/pi-ai` 中转站配置，[memory: llm-openai-protocol-relay](../../.claude/memory)——只用 openai-completions 协议），实现 finish_reason 归一化层（[ADR-0009](./decisions/0009-provider-anti-corruption-layer.md)）。

需要用户补的 env 变量：确认现有 `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`LLM_MODEL` 是否直接复用，还是要在 `apps/api` 下单独配一份。

怎么测：[testing-strategy.md §4.10](./testing-strategy.md#410-llm-proxy) unit 1-3、smoke 13（缺 credentials 自动 skip）。

验收标准：真实 provider 能返回响应，finish_reason 被正确归一化。

停下来确认。

### Step 14.3：Usage 记录（[ADR-0015](./decisions/0015-usage-telemetry-and-ops-priorities.md)）

要写的东西：每次 LLM proxy 调用后写入 `LLMUsageRecord`。

怎么测：[testing-strategy.md §4.10](./testing-strategy.md#410-llm-proxy) route 8。

验收标准：usage 记录形状正确，不影响 run 是否能继续执行。

停下来确认。

---

## Group 15：Search Proxy + 工具协议（[ADR-0020](./decisions/0020-agent-event-payload-schema-and-tool-retry.md)，解决 DQ-3）

### Step 15.1：Search Proxy 路由

要写的东西：`POST /api/search-proxy`，fake provider 模式先跑通，重试逻辑（5xx 重试 2 次，4xx 不重试）。

怎么测：[testing-strategy.md §4.11](./testing-strategy.md#411-search-proxy) 全部 8 条。

验收标准：fake provider 模式全部通过，重试逻辑用可控的 fake 网络层验证（不依赖真实 Brave API 的不确定性）。

停下来确认。

### Step 15.2：真实 search provider 接入

要写的东西：接入真实 search API（如 Brave）。

需要用户补的 env 变量：search provider 的 API key（如 `BRAVE_SEARCH_API_KEY`，具体到时候确认用哪家）。

验收标准：真实调用能返回结果（smoke test，缺 key 自动 skip）。

停下来确认。

### Step 15.3：fetch_url 工具（SSRF guard + 重试）

要写的东西：sandbox 侧 `fetch_url` 工具实现，SSRF guard、截断、重试逻辑（[agent-runtime-protocol.md](./agent-runtime-protocol.md) §8.5）。

怎么测：[testing-strategy.md §4.12](./testing-strategy.md#412-tools-web_search--fetch_url) unit 1-6、integration 7-11。

验收标准：SSRF guard 拦截私有网段/localhost/云 metadata 地址；网络失败按策略重试或直接失败；SSRF 触发产生 `rejected` 不是 `failed`。

停下来确认：这是一个安全边界相关的步骤，建议用户重点 review SSRF guard 的具体网段覆盖是否完整。

### Step 15.4：web_search 工具（走 search proxy）

要写的东西：sandbox 侧 `web_search` 工具，调 Step 15.1 的代理端点。

怎么测：[testing-strategy.md §4.12](./testing-strategy.md#412-tools-web_search--fetch_url) integration 12-14。

验收标准：搜索结果转化为 Source 记录。

停下来确认。

---

## Group 16：真实 Sandbox Agent Loop（ADR-0011/0016/0017/0021 全部汇合的地方）

### Step 16.1：Agent loop 骨架（不带 token 攒批，先用非流式响应跑通）

要写的东西：sandbox 内的 agent loop 主循环（[agent-runtime-protocol.md](./agent-runtime-protocol.md) §5.3），先用非流式（一次性拿完整响应）跑通"调 LLM proxy → 解析工具调用 → 执行 → ingest"的基本循环，暂不接流式攒批。

怎么测：integration test——真实 agent loop（用 fake LLM proxy 返回预设的工具调用序列）跑一个简单任务，验证能写文件、创建 artifact、完成 run。

验收标准：对应原 roadmap Phase 13 的核心验收——"real run 可以研究一个主题，agent 写 workspace files，agent 创建 markdown artifact"，但这一步先用 fake LLM 驱动，不要求真实智能程度。

停下来确认。

### Step 16.2：接入流式 + token 攒批（ADR-0017）+ Redis 转发（ADR-0021）

要写的东西：把 Step 16.1 的非流式改造成流式，实现 `accumulatedText` 内存攒批、语义边界触发落库、同时转发 chunk 到 Group 13 的 stream-chunk 端点。

怎么测：[testing-strategy.md §4.10](./testing-strategy.md#410-llm-proxy) integration 10-12。

验收标准：token 逐字通过 SSE 可见（前端此时还没做，用测试脚本订阅 SSE 验证），落库次数只和语义边界次数成正比（不是 token 数量）。

停下来确认：这一步是整个协议设计里最复杂的部分（双通道），建议做一次专门的手动演示（跑一个真实 run，打开日志看 stream-chunk 调用频率 vs ingest/events 调用频率），确认两者的量级符合 ADR-0017 的预期（"25 次左右，不是 3 万次"）。

### Step 16.3：waiting_for_input 完整链路（ADR-0019）

要写的东西：agent loop 判断"需要用户输入"时上报 `run_waiting_for_input` 并正常退出；前端（暂时用测试脚本模拟）创建新 run 时正确原子转移旧 run。

怎么测：[testing-strategy.md §4.4](./testing-strategy.md#44-run) integration 28-31。

验收标准：Stage1→waiting_for_input→Stage2 全链路走通，对应 [ADR-0013](./decisions/0013-mechanism-deep-dive-refinement.md) 的核心产品交互。

停下来确认：这是产品叙事的核心验证点，建议做一次完整的端到端手动演示。

### Step 16.4：cancel + timeout 收敛

要写的东西：agent loop 侧的 cancel 处理（[agent-runtime-protocol.md](./agent-runtime-protocol.md) §10），Control Plane 侧的取消请求处理。

怎么测：对应原 roadmap 里 cancel/timeout 相关的 integration 测试（并入 Group 18 sweep 一起验证收敛性）。

验收标准：cancel 请求能让 agent loop 在合理时间内停止。

停下来确认。

---

## Group 17：Usage 遥测（原 Credits，[ADR-0015](./decisions/0015-usage-telemetry-and-ops-priorities.md)）

### Step 17.1：`GET /api/usage/records` 查询端点

要写的东西：分页查询接口，支持按 runId/provider/model 过滤（数据本身已经在 Group 14.3/15.1 的调用里产生）。

怎么测：[testing-strategy.md §4.13](./testing-strategy.md#413-usage) route 1-4、integration 5-7。

验收标准：查询正常，且能明确验证"不存在任何因用量拒绝 run 的路径"（负向测试）。

停下来确认。

---

## Group 18：Sweep（含孤儿资源清理，[ADR-0015](./decisions/0015-usage-telemetry-and-ops-priorities.md)；waiting_for_input 阈值，[ADR-0019](./decisions/0019-waiting-for-input-state.md)）

### Step 18.1：Sweep 核心逻辑（run 收敛）

要写的东西：定时任务逻辑（先写成一个可独立调用的函数，不依赖 Vercel Cron 触发，方便测试）：扫描 heartbeat 过期的非终态 run，按 [state-machines.md](./state-machines.md) §11 策略收敛。

怎么测：[testing-strategy.md §4.4](./testing-strategy.md#44-run) integration 26-27、32。

验收标准：stale run 被正确收敛，并发场景下和正常上报路径不会互相覆盖（复用 ADR-0018 的 `transitionRun`）。

停下来确认。

### Step 18.2：waiting_for_input 阈值兜底

要写的东西：sweep 扫描超过 7 天（默认值）的 `waiting_for_input` run，转 `interrupted`。

怎么测：[testing-strategy.md §4.4](./testing-strategy.md#44-run) integration 30-31。

验收标准：阈值内不误杀，超阈值正确收敛。

停下来确认。

### Step 18.3：孤儿资源清理（SandboxInstance + Redis stream）

要写的东西：清理孤儿 `SandboxInstance`（[testing-strategy.md §4.6](./testing-strategy.md#46-sandbox) integration 14）、过期 Redis stream key（复用 Group 13.3 写好的函数）。

怎么测：对应的孤儿资源清理测试。

验收标准：孤儿资源被正确回收，不影响活跃资源。

停下来确认。

### Step 18.4：接入 Vercel Cron

要写的东西：把 Step 18.1-18.3 的函数接到 `/api/sweep` 端点，配置 Vercel Cron 定期调用。

需要用户补的东西：Vercel 项目里配置 Cron（这一步需要用户在 Vercel Dashboard 操作，或者用 `vercel.json` 声明，具体到时候确认）。

验收标准：本地/预览环境能手动触发验证，Cron 配置本身留给部署阶段确认生效。

停下来确认。这个 Group 完成后，"没有任何 run 允许永久停留在非终态"这条系统级不变量（[ADR-0008](./decisions/0008-sweep-safety-net.md)）第一次被完整代码实现验证。

---

## Group 19：UI Shell

到这里，后端 API 已经全部用测试证明可用，才开始做 UI（[testing-strategy.md](./testing-strategy.md) §1.5/§2 的核心原则："不要让 UI 依赖想象中的后端行为"）。这个 Group 的具体子步骤（App Shell → Sidebar → Conversation/Composer → Run Timeline → Artifact Preview/Panel）在到达这一步时会展开成更细的 Step，遵循 [design-system.md](./design-system.md) 已定的布局和交互规则（含 ADR-0019 的 composer 规则、`useComposerEnabled` 共享 hook）。此处先占位，不提前展开细节——UI 阶段的实现顺序可能因为到时候的具体前端框架选型细节（如是否用 shadcn 组件库的具体版本）有调整空间，到达这个 Group 时再和用户对齐一次。

---

## Group 20：Browser E2E

覆盖 [testing-strategy.md §1.5](./testing-strategy.md#15-browser-e2e) 和 §4.14 E2E 部分：login → create workspace → create thread → start run → 观察 waiting_for_input → 用户选择 → Stage2 深挖 → open artifact → cancel run。到达这个 Group 时展开具体子步骤。

---

## Group 21：部署和运维

覆盖 sweep 生产环境验证、secrets 管理、日志可观测性（能定位 runId/workspaceId 且不泄露敏感内容）、[ADR-0022](./decisions/0022-monorepo-hono-backend.md) 的两个独立 Vercel 项目部署配置、cookie domain 生产配置。到达这个 Group 时展开具体子步骤。

---

## 当前状态

Group 0（PoC）、Group 1（文档校订）、Group 2（Monorepo 脚手架）已完成。Group 3 Step 3.1（Better Auth 接入）已完成。下一步是 Step 3.2：`GET /api/me` + 受保护路由 helper（requireUser）。

按规矩，每完成一个 Step 就停下来等确认，不会连续做完多个 Step。

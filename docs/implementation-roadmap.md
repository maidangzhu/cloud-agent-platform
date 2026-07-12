# 实现路线图 — 逐步执行 + 每步停下确认

这份文档取代 [research-agent-tdd-roadmap.md](./research-agent-tdd-roadmap.md) 里过时的 Phase 划分（那份文档的 Phase 粒度太粗，且没吃进 [ADR-0018~0022](./decisions/README.md)）。本文档的粒度是"一步能在一次对话里做完并验证"，不是"一整块功能"。

## 使用规则

- 每个 Step 写清楚：要写什么代码、要写多少、怎么测、验收标准、要不要用户补 env、做完在哪里停下来确认。
- **每个 Step 做完必须停下来，等用户明确确认后才进入下一个 Step。** 不允许因为"看起来很清楚"就连续做完多个 Step 不停顿。
- 每个 Step 都必须有对应的自动化测试（PoC 类步骤除外，PoC 用手动跑脚本验证，不计入正式测试套件）。
- 测试用例的具体断言清单见 [testing-strategy.md](./testing-strategy.md) §4（按领域标注了序号，Step 执行时按需引用对应编号，不重复罗列）。
- 涉及数据库/沙箱/Redis 的步骤，默认 `pnpm test` 仍保持零外部依赖；需要真实外部资源的测试按范围标注为 component integration / workflow / live，单独跑。

## 总览：Step 分组

```text
Group 0：PoC（环境连通性）— 已完成
Group 1：文档校订（ADR-0018~0022 + 关联文档修订）— 已完成
Group 2：Monorepo 脚手架（ADR-0022）— 已完成
Group 3：Auth（Better Auth 挂 apps/api）— 已完成
Group 4：Workspace — 已完成
Group 5：Thread — 已完成
Group 6：Run 状态机 + Event Store（含 ADR-0018/0019）— 已完成
Group 7：Scoped Run Token — 已完成
Group 8：Ingest API 基线（含 ADR-0020 payload schema）— 已完成
Group 9：Scripted Sandbox Runner — 已完成
Group 10：Workspace Files — 已完成
Group 11：Artifacts（含版本化，ADR-0020）— 已完成
Group 12：Sources — 已完成
Group 13：Token Stream 转发（Redis Streams，ADR-0021）— 已完成
Group 14：LLM Proxy — 已完成
Group 15：Search Proxy + web_search/fetch_url 工具协议（ADR-0020）— 已完成
Group 16：真实 Sandbox Agent Loop — 已完成
Group 17：Usage 遥测（原 Credits，ADR-0015）— 已完成
Group 18：Sweep（含孤儿资源清理，ADR-0015；waiting_for_input 阈值，ADR-0019）— 代码已实现，待本轮提交确认
Group 19：UI Shell — 主体已完成并提交，剩余前端协议细化见当前状态
Group 20：Browser E2E
Group 21：Hosted Control Plane 部署和运维 — 当前优先级最高
Group 22：Pi AI Agent Runtime 替换
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
- 暂不接 Vercel Hono zero-config entry、暂不部署，先本地跑通。

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

### Step 3.2：`GET /api/me` + 受保护路由 helper ✅

要写的东西：

- `apps/api` 的 `requireUser()` helper。
- `GET /api/me` 路由，返回 `MeData`（[api-contract.md](./api-contract.md) §5.1，注意不再包含 credits）。

怎么测：[testing-strategy.md §4.1](./testing-strategy.md#41-auth) route 测试 4-7。

验收标准：未登录 401，已登录返回 user。

停下来确认：这是第一个端到端可验证的真实业务端点，建议用户此时通过浏览器/curl 手动走一次注册→登录→`GET /api/me` 全流程再确认。

---

## Group 4：Workspace

### Step 4.1：Workspace 数据模型 + CRUD 路由 ✅

要写的东西：

- `packages/db` 的 `Workspace` 表迁移。
- `apps/api` 的 workspace 路由：`GET/POST /api/workspaces`、`GET/PATCH/DELETE /api/workspaces/:workspaceId`。
- title validation、archive 策略（[state-machines.md](./state-machines.md) §3）。

怎么测：[testing-strategy.md §4.2](./testing-strategy.md#42-workspace) unit 1-5、route 6-15。

验收标准：CRUD 全部通过 API 测试闭环，跨用户访问不可能。

**实测踩坑：**

1. **v1/v2 model 命名冲突且有真实生产数据**：v1 的 `Workspace` model 语义是"沙箱实例状态"，与 v2 顶层概念 Workspace 冲突，且这张表在真实 Neon 数据库里存有 97 条历史数据。险些因为用错表名大小写（PostgreSQL 表名大小写敏感）误判"表无数据"，差点执行 `--force-reset` 丢失数据——被 Prisma 自身的安全校验（拒绝无默认值加必填列）拦下。之后任何 v1/v2 model 重命名，先用 `SELECT count(*) FROM "ExactCaseTableName"`（带双引号原样大小写）确认真实数据量，不要凭直觉判断"应该没数据"。
2. **根目录 tsconfig.json 未排除 monorepo 子包**：早期根 Next.js app 的 `include: ["**/*.ts", ...]` + `exclude: ["node_modules"]` 会让根目录 build 类型检查扫描 `apps/`、`packages/` 下的代码，一处子包内的真实类型错误会直接拖挂根目录 build。根 Next.js app 删除后，根 tsconfig 也随之移除，类型检查改由各 workspace 自己负责。

停下来确认。

### Step 4.2：Workspace 归档的原子拒绝（[ADR-0018](./decisions/0018-atomic-state-transitions.md)） ✅

要写的东西：

- 创建 run/thread 时的 insert-select 原子拒绝逻辑（这一步先只搭 workspace 侧，thread/run 表还没建，先写一个针对 workspace 状态检查的独立小函数，为后续 Group 5/6 复用打基础）。

怎么测：[testing-strategy.md §4.2](./testing-strategy.md#42-workspace) integration 16-17（并发竞态测试）。

验收标准：并发下只有一种结果，不会出现"先查后建"的窗口。

**范围调整**：与用户确认后，提前建了一张最小 `Thread` 表（只为真实验证并发拒绝，不实现完整 CRUD/title 派生，那些留给 Group 5）——`testing-strategy.md` 的 integration 16-17 断言名字明确要求"rejects run/thread creation"，没有一张表无法真实验证，与本节原计划"先只搭独立函数"的措辞有时序矛盾。

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

验收标准（当时）：能创建/查询/取消 run；该 Step 尚未接真实 sandbox，`created` 停留是当时的阶段性预期。当前产品主路径已在后续步骤接入自动 runner 调度，不能再把长期停留 `created` 视为完成。

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

- `GET /api/runs/:runId/events` SSE 端点：snapshot + 新事件推送 + done。（后续浏览器主路径改为 POST，GET 保留兼容。）
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

## Group 9：Scripted Sandbox Runner

### Step 9.1：Scripted ingest fixture（不计入 sandbox 覆盖）

要写的东西：

- `testing` helper：一个可配置行为的 scripted ingest fixture（模式：complete/fail/timeout/cancel-aware/file-write/artifact-create/source-record）。
- fixture 只通过 ingest HTTP API 和 scoped run token 与系统交互，不直接碰数据库。它用于稳定回归 ingest/files/artifacts/sources 行为，但不作为 sandbox 创建/复用/runner 启动的验收依据。

怎么测：ingest/files/artifacts/sources 的 route/integration 回归测试。凡是测试名或验收点涉及 sandbox，必须进入 Step 9.2 并使用真实 Vercel Sandbox。

验收标准：scripted ingest fixture 能完成一个 run 的完整生命周期（心跳→事件→文件→artifact→终态），全程只用 HTTP；不把这一步计为 sandbox 覆盖。

停下来确认。

### Step 9.2：接入真实 Vercel Sandbox（scripted runner 代码跑在真沙箱里）

要写的东西：

- 使用 `apps/api/src/sandbox/factory.ts`（由已验证过的 Vercel Sandbox 封装迁入）。
- Control Plane 侧的 sandbox 认领逻辑（[ADR-0018](./decisions/0018-atomic-state-transitions.md) `currentRunId` 原子认领）。
- 把 scripted runner 脚本上传到真实沙箱并启动。

怎么测：[testing-strategy.md §4.6](./testing-strategy.md#46-sandbox) integration 3-14。

验收标准：scripted runner 确实在 Vercel Sandbox microVM 里运行（不是本地进程），Control Plane 只能通过 ingest 观察它，SandboxInstance 复用互斥测试通过。

停下来确认：这一步涉及真实计费资源（Vercel Sandbox），建议用户此时关注一下 Vercel 账单/用量，确认测试频率可接受。

---

## Group 10：Workspace Files

### Step 10.1：File ingest + 查询路由

要写的东西：`POST /api/ingest/files`、`GET /api/workspaces/:workspaceId/files`、`GET .../files/content`，path guard、content hash、size policy。

怎么测：[testing-strategy.md §4.7](./testing-strategy.md#47-files) unit 1-4、route 5-12。

验收标准：路径穿越被拒绝，正常文件读写通过。

停下来确认。

### Step 10.2：Scripted runner 写文件的端到端验证

要写的东西：把 Group 9 的 scripted runner 扩展出 `write_file` 行为，串联 Group 10.1 的 ingest 端点。

怎么测：[testing-strategy.md §4.7](./testing-strategy.md#47-files) integration 13-15。

验收标准：scripted runner 写的文件刷新后仍可读（从 DB 而不是从沙箱内存）。

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

停下来确认。这个 Group 完成后，对应原 roadmap 到 Phase 11 为止的全部内容已经用 scripted runner 验证完毕，下一步开始接真实基础设施（Redis token 流、真实 LLM）。

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

要写的东西：`GET /api/runs/:runId/events` 增加"订阅 Redis stream 并按 cursor 转发"这一层，处理 `Last-Event-ID` header。（后续浏览器主路径改为 POST，并在 body 中支持 `lastEventId`。）

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

要写的东西：接入真实 LLM（复用 Pi AI `@earendil-works/pi-ai` 的 openai-completions 协议配置，[memory: llm-openai-protocol-relay](../../.claude/memory)），实现 finish_reason 归一化层（[ADR-0009](./decisions/0009-provider-anti-corruption-layer.md)）。

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

验收标准：fake provider 模式全部通过，重试逻辑用可控的 fake 网络层验证（不依赖真实 Exa API 的不确定性）。

停下来确认。

### Step 15.2：真实 search provider 接入

要写的东西：接入真实 search API（Exa）。

需要用户补的 env 变量：`EXA_API_KEY`。

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

怎么测：workflow test——真实 agent loop（用 fake LLM proxy 返回预设的工具调用序列）跑一个简单任务，验证能写文件、创建 artifact、完成 run。

验收标准：对应原 roadmap Phase 13 的核心验收——"real run 可以研究一个主题，agent 写 workspace files，agent 创建 markdown artifact"，但这一步先用 fake LLM 驱动，不要求真实智能程度。

停下来确认。

### Step 16.2：接入流式 + token 攒批（ADR-0017）+ Redis 转发（ADR-0021）

要写的东西：把 Step 16.1 的非流式改造成流式，实现 `accumulatedText` 内存攒批、语义边界触发落库、同时转发 chunk 到 Group 13 的 stream-chunk 端点。

怎么测：[testing-strategy.md §4.10](./testing-strategy.md#410-llm-proxy) workflow 10-12。

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

### Step 18.1：Sweep 核心逻辑（run 收敛） ✅

要写的东西：定时任务逻辑（先写成一个可独立调用的函数，不依赖 Vercel Cron 触发，方便测试）：扫描 heartbeat 过期的非终态 run，按 [state-machines.md](./state-machines.md) §11 策略收敛。

怎么测：[testing-strategy.md §4.4](./testing-strategy.md#44-run) integration 26-27、32。

验收标准：stale run 被正确收敛，并发场景下和正常上报路径不会互相覆盖（复用 ADR-0018 的 `transitionRun`）。

停下来确认。

### Step 18.2：waiting_for_input 阈值兜底 ✅

要写的东西：sweep 扫描超过 7 天（默认值）的 `waiting_for_input` run，转 `interrupted`。

怎么测：[testing-strategy.md §4.4](./testing-strategy.md#44-run) integration 30-31。

验收标准：阈值内不误杀，超阈值正确收敛。

停下来确认。

### Step 18.3：孤儿资源清理（SandboxInstance + Redis stream） ✅

要写的东西：清理孤儿 `SandboxInstance`（[testing-strategy.md §4.6](./testing-strategy.md#46-sandbox) integration 14）、过期 Redis stream key（复用 Group 13.3 写好的函数）。

怎么测：对应的孤儿资源清理测试。

验收标准：孤儿资源被正确回收，不影响活跃资源。

停下来确认。

### Step 18.4：接入 Vercel Cron ✅

要写的东西：把 Step 18.1-18.3 的函数接到 `/api/sweep` 端点，配置 Vercel Cron 定期调用。

需要用户补的东西：Vercel 项目里配置 Cron（这一步需要用户在 Vercel Dashboard 操作，或者用 `vercel.json` 声明，具体到时候确认）。

验收标准：本地/预览环境能手动触发验证，Cron 配置本身留给部署阶段确认生效。

停下来确认。这个 Group 完成后，"没有任何 run 允许永久停留在非终态"这条系统级不变量（[ADR-0008](./decisions/0008-sweep-safety-net.md)）第一次被完整代码实现验证。

---

## Group 19：UI Shell

到这里，后端 API 已经全部用测试证明可用，才开始做 UI（[testing-strategy.md](./testing-strategy.md) §1.5/§2 的核心原则："不要让 UI 依赖想象中的后端行为"）。这个 Group 的具体子步骤（App Shell → Sidebar → Conversation/Composer → Run Timeline → Artifact Preview/Panel）在到达这一步时会展开成更细的 Step，遵循 [design-system.md](./design-system.md) 已定的布局和交互规则（含 ADR-0019 的 composer 规则、`useComposerEnabled` 共享 hook）。此处先占位，不提前展开细节——UI 阶段的实现顺序可能因为到时候的具体前端框架选型细节（如是否用 shadcn 组件库的具体版本）有调整空间，到达这个 Group 时再和用户对齐一次。

### Step 19.1：App Shell 骨架 ✅

要写的东西：在 `apps/web` 建立独立 Next App Router 前端壳，完成左 sidebar / 中 conversation / 右 artifact panel 的第一屏布局、基础 design tokens、移动端单栏响应式、`/api/*` 到 `apps/api` 的本地 rewrite。

怎么测：`apps/web` typecheck/build，Playwright 截图检查 desktop/mobile 首屏可见且不重叠。

验收标准：`apps/web` 可以独立启动；第一屏不是 landing page，而是可工作的 workspace shell 骨架；不接真实列表/消息/SSE，不实现业务数据流。

停下来确认。

### Step 19.2：Sidebar 数据流 ✅

要写的东西：接入 Better Auth session、workspace list、active workspace thread list、new workspace/new thread 操作，保留 sidebar 折叠/移动 drawer 的壳。

怎么测：route/component 层验证未登录、空列表、创建后刷新、active item。

验收标准：sidebar 从 API snapshot 恢复，不依赖内存状态。

停下来确认。

### Step 19.3：Conversation + Composer ✅

要写的东西：接入 thread snapshot、run 创建、`useComposerEnabled` 规则、cancel 操作、waiting_for_input 用户选择入口。

怎么测：composer enabled/disabled 状态、创建 run、cancel、waiting_for_input 到下一 run。

验收标准：中间 chat 是唯一输入通道，刷新后状态可恢复。

停下来确认。

### Step 19.4：Run Timeline + SSE ✅

要写的东西：接入 Control Plane SSE，渲染 run event、Redis stream chunks、tool call 完整对象和终态 done。

怎么测：SSE snapshot/resume、Last-Event-ID、tool call 不 token stream、终态关闭。

验收标准：实时流只是展示加速层，刷新仍以 API snapshot 为事实源。

停下来确认。

### Step 19.5：Artifact Preview / Panel ✅

要写的东西：artifact preview card、右侧 artifact panel、markdown/text 渲染、copy/download、版本切换的 P0 交互。

怎么测：artifact 创建中/已完成、打开/关闭、移动端 full-screen overlay、版本切换。

验收标准：artifact 是一等交付物，不只是 assistant message。

停下来确认。

---

## Group 20：Browser E2E

覆盖 [testing-strategy.md §1.7](./testing-strategy.md#17-browser-e2e) 和 §4.14 E2E 部分。

- [x] Step 20.1：hosted Playwright 配置，desktop/mobile 项目
- [x] Step 20.2：signup → workspace/thread/run → real Exa/tool/file/artifact/source/usage
- [x] Step 20.3：completed/cancelled run 刷新恢复
- [x] Step 20.4：policy rejection 与 run failure 可见性
- [ ] Step 20.5：waiting_for_input → 用户选择 → Stage2 深挖 → artifact update 浏览器交互（后端 workflow 已通过）

---

## Group 21：部署和运维

当前优先级调整：先把 hosted `apps/api` 打通，再继续依赖真实后端的前端/沙箱验证。详细执行入口见 [hosted-control-plane-deployment-plan.md](./hosted-control-plane-deployment-plan.md)。

### Step 21.1：拆分 app 级 Vercel 配置 ✅

要写的东西：

- 根目录不再作为 Vercel deploy target；根 `vercel.json` 的职责迁到 `apps/web/vercel.json` / `apps/api/vercel.json`。
- `apps/web` 保持 Next.js 项目，Root Directory 为 `apps/web`。
- `apps/api` 独立为 Hono serverless 项目，Root Directory 为 `apps/api`。

怎么测：本地 `pnpm --filter @cap/web build`、`pnpm --filter @cap/api typecheck` 通过；Vercel CLI preview deploy 不再从仓库根检测 Next.js。

验收标准：仓库根目录只承担 pnpm workspace 职责；Vercel 项目不会再因为根 `package.json` 缺少 `next` 而报 `No Next.js version detected`。

停下来确认。

### Step 21.2：给 `apps/api` 增加 Vercel Hono 入口 ✅

要写的东西：

- 新增 Vercel Hono zero-config entry（`src/server.ts`），default export 同一份 Hono app。
- 保留 `apps/api/src/index.ts` 的本地 `tsx watch` + `@hono/node-server` dev 入口。

怎么测：

- `pnpm --filter @cap/api typecheck`
- `pnpm --filter @cap/api test`
- 本地或 preview 环境访问 `/health`。

验收标准：同一份 Hono app 能在本地 Node server 和 Vercel Hono runtime 下运行。

停下来确认。

### Step 21.3：创建独立 API Vercel 项目前确认命名和域名

这一步涉及新建计费/部署资源，执行前必须向用户确认：

- Vercel 项目名是否使用 `cloud-agent-platform-api`。
- API 是否先用 Vercel 默认域名，还是绑定 `api.sandbox.maidang.me`。
- Web 是否配套使用 `app.sandbox.maidang.me`，以便后续 cookie domain 使用 `.sandbox.maidang.me`。

未确认前不新建项目、不绑定域名、不迁移 secrets。

停下来确认。

### Step 21.4：部署 hosted `apps/api` 并迁移环境变量

要写的东西/操作：

- 创建或链接 `apps/api` Vercel 项目，Root Directory 设为 `apps/api`。
- 迁移现有环境变量名：`DATABASE_URL`、`BETTER_AUTH_SECRET`、`BETTER_AUTH_URL`、`REDIS_URL`、`OPENAI_*`、`EXA_API_KEY`、`VERCEL_TOKEN`/`VERCEL_OIDC_TOKEN` 等。
- 不打印、不提交 secret 值，只验证变量存在和链路可用。

怎么测：

- `vercel deploy` preview Ready。
- `curl https://<api-host>/health` 返回 200。
- `CAP_API_BASE_URL=https://<api-host> pnpm --dir apps/api test:live` 至少跑过 deployed health / unauthenticated me smoke。

验收标准：`apps/api` 线上 Ready，`/health` 公网可访问，sandbox 可从公网回调 Control Plane。

停下来确认。

### Step 21.5：部署 `apps/web` 并指向 hosted API

要写的东西/操作：

- `apps/web` Vercel 项目 Root Directory 固定为 `apps/web`。
- 设置 `API_PROXY_TARGET=https://<api-host>`。
- 修复首页默认状态 UX：登录后不自动选中历史 thread，发送首条消息后才创建/选中新 thread。

怎么测：

- `pnpm --filter @cap/web typecheck`
- `pnpm --filter @cap/web build`
- Web preview Ready。
- 手动验证登录后首页为空 composer；发送消息后左侧出现 thread 且选中新 thread。

验收标准：线上 web Ready，API rewrite 不指向 `localhost:8787`，不会再报 `No Next.js version detected`。

停下来确认。

### Step 21.6：生产链路验证清单

怎么测：

- `pnpm typecheck`
- `pnpm build`
- `pnpm test:integration`
- `pnpm test:workflow`
- `CAP_API_BASE_URL=https://<api-host> pnpm --dir apps/api test:live`
- `openspec validate`（如果 CLI 可用）
- 隐私扫描：确认 sandbox/runtime env 不含 `DATABASE_URL`、Better Auth secret、长期 LLM provider key。

验收标准：明确回报 `apps/web` Ready、`apps/api` Ready、`/health` 公网可访问、首页默认空 composer、sandbox callback 走 hosted API。

停下来确认。

---

## Group 22：Pi AI Agent Runtime 替换

当前 `apps/api/src/agent-loop/*` 是为打通协议写的项目内 loop。产品方向改为 sandbox 内运行真实 Pi AI runtime（`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`）；自写 loop 只能保留为 deterministic fixture/迁移垫片，不能作为最终产品主路径。

### Step 22.1：Pi AI runtime 接入调研和启动协议

要写的东西：

- 固定 Pi AI runtime 的安装方式（`@earendil-works/pi-agent-core@0.80.3` + `@earendil-works/pi-ai@0.80.3`）、启动命令、配置格式、tool adapter 机制。
- 明确 sandbox 内 runtime 需要的最小 env/config，禁止传入 DB/Auth/长期 provider secrets。

怎么测：在真实 Vercel Sandbox 内手动启动 Pi AI runtime，跑通健康检查或最小 task。

停下来确认。

### Step 22.2：Control Plane adapter

要写的东西：

- Pi AI ingest client。
- LLM proxy client。
- search/fetch/file/artifact tools adapter。
- cancel polling 和 heartbeat。

怎么测：workflow test 使用 deterministic mode，证明 Pi AI runtime 通过 hosted API 完成 run。

停下来确认。

### Step 22.3：替换产品主路径

要写的东西：

- run 创建后的 sandbox 启动逻辑改为启动 Pi AI runtime。
- 自写 loop 降级为测试 fixture 或删除。

怎么测：`WF-010`、`LIVE-005`、`LIVE-006` 通过真实 hosted API + Vercel Sandbox 验证。

验收标准：产品主路径不再依赖项目内自写 agent loop。

停下来确认。

---

## 当前状态

截至本轮：

- Group 0-17 已完成，后端主链路已经覆盖 workspace/thread/run、ingest、SSE、Redis Streams、files/artifacts/sources、LLM/Search/fetch tools、真实 sandbox agent loop、usage telemetry。
- Group 18 Sweep 已实现并通过验证，当前仍在工作区未提交：stale `created`/`running`/`provisioning_sandbox`/`cancel_requested`/`waiting_for_input` run 收敛、孤儿 SandboxInstance 清理、过期 Redis stream 清理、`/api/sweep` + Vercel Cron。
- Group 19 UI Shell 主体已提交到 `35059ae finish web rebuild with run recovery`，本轮继续未提交改动：登录态首页改为默认 workspace + 中央 composer，首条消息自动创建 thread；SSE 前端从原生 `EventSource` 改为 `@microsoft/fetch-event-source`，通过 `POST /api/runs/:runId/events` 建连，服务端保留 GET 兼容并新增 POST。
- 本轮已接上 run 创建后的真实 runner 调度入口：`POST /api/threads/:threadId/runs` 创建 run 后会按配置自动触发真实 Vercel Sandbox orchestration，签发 scoped run token，认领/创建 `WorkspaceSandboxInstance`，启动 `agent-loop` 脚本；runner 继续只通过 ingest/llm/control HTTP API 回写 heartbeat/events/files/artifacts/sources。测试环境默认不自动拉真实沙箱，显式 workflow/live 场景通过 `CAP_RUNNER_AUTO_START=true` 打开，并且需要一个沙箱内可访问的公网 Control Plane base URL（如 `PUBLIC_AGENT_LOOP_BASE_URL`/`CAP_API_BASE_URL`；localhost 型 `BETTER_AUTH_URL` 不能作为 Vercel Sandbox callback base）。
- Group 19 仍有一个前端协议缺口：`frontend-shell` 要求 composer enabled 规则封装为共享 `useComposerEnabled` hook。
- 当前最高优先级改为 Group 21：先完成 hosted Hono Control Plane 部署，让本地/线上 web 和 Vercel Sandbox 都能打公网 API。后台审计日志、Browser E2E 顺延到 hosted API 可用之后。
- Group 22 新增 Pi AI Agent Runtime 替换计划：现有自写 `apps/api/src/agent-loop/*` 不再视为最终产品 runtime，只能作为迁移期间 fixture。

按规矩，每完成一个 Step 就停下来等确认，不会连续做完多个 Step。当前因为前端重做任务已经跨 Step 完成，本文档以真实提交/验证结果回填进度。

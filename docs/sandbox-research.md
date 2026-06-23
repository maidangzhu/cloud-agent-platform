# Vercel Sandbox 方案调研

> 调研目的：确认本项目沙箱隔离层用 Vercel Sandbox 落地的可行性、API、认证、限制、成本与接入方式。结论一手来自已安装的 `@vercel/sandbox@2.2.1` 类型定义、参考项目 Open Agents 的封装、以及 Vercel 官方文档。

## 1. 结论先行

- **Vercel Sandbox = 按需启动的隔离 Linux microVM**（Firecracker），用于运行不可信代码 / AI 生成的命令。正是本题「云端隔离环境执行」所需。
- **本项目策略**：定义统一 `Sandbox` 接口 + 双实现。`LocalSandbox`（临时目录）用于 TDD 与本地 dev（零外部依赖）；`VercelSandbox`（`@vercel/sandbox`）用于生产隔离。切换只改 `SANDBOX_PROVIDER` 环境变量。
- **关键边界**：agent loop 跑在 server，沙箱只是「工具伸手进去执行危险动作」的隔离环境。平台 DB 只存沙箱**状态引用**，不存文件系统。
- **可行性**：本地已装 SDK，API 清晰；本地 Vercel CLI 已登录，认证可走 `vercel link` + `vercel env pull`。风险点是真实 microVM 调通的不确定性，因此用 LocalSandbox 兜底，Vercel 作为生产 adapter 在阶段 5 验证。

## 2. SDK 核心 API（@vercel/sandbox 2.2.1，一手确认）

### 创建 / 获取

```ts
import { Sandbox } from "@vercel/sandbox";

// 创建（可带 git 源、超时、资源、运行时、网络策略）
const sandbox = await Sandbox.create({
  source: { type: "git", url, revision, depth },   // 也支持 tarball / snapshot
  timeout: 300_000,                                  // ms，默认 5 分钟
  resources: { vcpus: 4 },                           // 每 vCPU = 2048 MB 内存
  runtime: "node24",                                 // node22 / node24 / node26 / python3.13
  ports: [3000],                                     // 最多暴露 4 个端口
  networkPolicy,                                     // 默认全网放行，可收紧
  env: { NODE_ENV: "production" },
  persistent: true,                                  // 会话间自动恢复文件系统
});

await Sandbox.get({ sandboxId });        // 重连已有沙箱
await Sandbox.getOrCreate({ name });     // 命名沙箱：存在则连，不存在则建
await Sandbox.fork({ sourceSandbox });   // 从已有沙箱的快照分叉
await Sandbox.list();                     // 分页列出
```

`Sandbox.create()` 返回 `Sandbox & AsyncDisposable`，支持 `await using` 自动停止。

### 命令执行

```ts
const result = await sandbox.runCommand("npm", ["install"], {
  cwd, env, signal,                       // 支持 AbortSignal 取消
});
// result: CommandFinished { exitCode, stdout(), stderr() }

sandbox.openInteractive(...)              // 交互式
sandbox.getCommand(cmdId)                 // 查正在跑的命令
```

### 文件系统

```ts
await sandbox.readFile({ path });          // 读
await sandbox.readFileToBuffer({ path });  // 读为 Buffer（大文件，绕过命令输出上限）
await sandbox.writeFiles([{ path, content }]);  // 写（流式，绕过参数大小限制）
await sandbox.mkDir(path, { recursive });
await sandbox.readDir(path);
```

### 快照 / 生命周期

```ts
await sandbox.snapshot();                  // 创建文件系统快照（会自动停止沙箱）
sandbox.currentSession();                  // 当前会话元数据（含 timeout、status）
await sandbox.stop();                       // 停止并清理
sandbox.domain(port);                       // 暴露端口的公网 URL
// snapshotExpiration / keepLastSnapshots：快照过期与保留策略（保留最近 1-10 个）
```

## 3. 认证

`@vercel/sandbox` 的 `Credentials` 需要三项：

```ts
interface Credentials {
  token: string;      // Vercel API token（OIDC token 或 personal access token）
  projectId: string;
  teamId: string;
}
```

两种方式：

- **本地开发**：`vercel link`（关联项目）→ `vercel env pull`（拉开发 token）。SDK 自动从环境读取。本项目本地 Vercel CLI 已登录，走这条。
- **生产（部署在 Vercel 上）**：认证自动完成，OIDC token 自动注入，无需手动配。

环境变量层面通常对应 `VERCEL_TOKEN` / `VERCEL_PROJECT_ID` / `VERCEL_TEAM_ID`（或由 `vercel env pull` 生成的 `.env.local` 提供）。

## 4. 限制与定价（官方文档，2026 状态）

| 项 | Hobby | Pro / Enterprise |
| --- | --- | --- |
| 单沙箱最大资源 | 8 vCPU / 2GB 每 vCPU | 同；Enterprise 可达 32 vCPU / 64 GB |
| 最大运行时长 | 45 分钟 | 5 小时（部分已支持 24 小时） |
| 默认超时 | 5 分钟 | 5 分钟 |
| vCPU 分配速率 | 40 / 10min | 200/min（Pro）、400/min（Ent） |
| 暴露端口 | 最多 4 个 | 同 |

**计费（Pro/Enterprise 按量）**：约 $0.128 / vCPU-hour（仅计 Active CPU，I/O 等待不计）、$0.0212 / GB-hour 内存、$0.60 / 百万次创建、$0.15 / GB 数据传输。Pro 计划有 $20/月额度抵扣，Hobby 有每月免费额度。

**对本项目的含义**：MVP 的 demo 任务（读 demo repo、搜 TODO、生成报告）很轻，默认 5 分钟超时、4 vCPU 绰绰有余，成本可忽略。我们仍设 `maxSteps`、每工具 timeout、run 级 wall time buffer 防失控。

## 5. Open Agents 的封装（借鉴对象）

参考项目 `packages/sandbox`（MIT）把 Vercel SDK 封装成一个干净的 `Sandbox` 接口 + provider 实现，值得借鉴的设计：

**统一接口**（`interface.ts`）：`readFile / readFileBuffer / writeFile / stat / access / mkdir / readdir / exec / stop / getState`，外加可选的 `snapshot / extendTimeout / domain / execDetached`。Vercel 只是其中一个 backend。

**状态持久化**（`vercel/state.ts`）—— 平台 DB 只存这个引用，不存文件系统：

```ts
interface VercelState {
  source?: Source;        // clone 来源（重连时省略）
  sandboxName?: string;   // durable 命名沙箱，用于重连 / resume
  snapshotId?: string;    // 快照恢复（legacy 迁移）
  expiresAt?: number;     // 当前会话过期时间戳
}
```

**重连逻辑**（`vercel/connect.ts`）：`connectSandbox(state)` 根据 state 决定「重连已有命名沙箱」还是「新建」；用 `expiresAt` 算剩余 timeout，过期则回退。404 时按 not-found 处理。

**封装里的工程细节**（我们 P0 可简化，但值得记录）：
- 命令输出截断上限 `MAX_OUTPUT_LENGTH = 50_000`。
- `TIMEOUT_BUFFER_MS = 30_000`：在 SDK 超时前留 buffer 跑 `beforeStop` hook（保存/清理）。
- `readFileToBuffer` / `writeFiles` 走 SDK 原生流式接口，避免命令行 `cat`/base64 的大小限制。
- 生命周期钩子 `afterStart / beforeStop / onTimeout / onTimeoutExtended`。
- 网络策略：默认全网放行；如需 GitHub 凭证代理，临时改 networkPolicy 注入 token，用完即清。

## 6. 本项目的接口设计

P0 定义最小 `Sandbox` 接口（参见 `architecture.md` 第 7 节、spec `sandbox-isolation`）：

```ts
interface Sandbox {
  readonly workingDir: string;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  readdir(path: string): Promise<DirEntry[]>;
  exec(command: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<ExecResult>;
  snapshot(): Promise<{ snapshotId: string }>;  // ② 快照恢复
  stop(): Promise<void>;
  getState(): unknown;                          // 落库的状态引用（sandboxName/snapshotId 等）
}

// 工厂：按 session 复用，不存在则创建，原沙箱被回收则从 snapshot 恢复
getOrCreateSandbox(workspace): Promise<Sandbox>;
```

两个实现：

| | LocalSandbox | VercelSandbox |
| --- | --- | --- |
| 后端 | 固定目录 `tmpdir/cap/<sessionId>` | `@vercel/sandbox` microVM |
| 用途 | TDD + 本地 dev | 生产隔离 |
| 依赖 | 零 | Vercel 账号 + token |
| 隔离强度 | 进程内 + path guard | Firecracker microVM |
| 复用/恢复 | 目录在则复用；可 tar 模拟快照 | `getOrCreate(name)` + `snapshot()`/resume |

所有路径经 `path-guard` 归一化并限制在 `workingDir` 内（防 `../` 越权），命令经 policy 白名单 + timeout + 输出截断。两个实现共享这套保护逻辑。

### workspace 会话内持久（跨请求、跨沙箱实例）（snapshot/resume 分层）

多轮会话下 workspace 必须跨请求、跨沙箱实例存活，分三层（P0 做 ①②，不做 ③）：

| 层 | 机制 | Vercel SDK 支持 | LocalSandbox | 范围 |
| --- | --- | --- | --- | --- |
| ① 文件延续 | persistent 命名沙箱，`getOrCreate({name, persistent:true})` 活着复用、死了重建 | 原生 | 固定目录复用 | **P0 必做** |
| ② 快照恢复 | 停止前 `snapshot()`，回来 `create({source:{type:snapshot,snapshotId}})` resume | 原生 | tar 目录模拟 | **P0 增强** |
| ③ 自动 hibernate 编排 | 定时判断空闲→休眠→lease→定时检查 | 需自建 workflow | — | **P1，不做** |

关键认知：让 Open Agents 那套显得复杂的是 ③（自动 hibernate 的生命周期 workflow），不是 snapshot 本身。①② 都是 Vercel SDK 原生能力（`persistent` 参数 + `snapshot()` + 从 snapshot `create`），P0 可控。

「过两天回来继续对话」恢复路径：对话历史读 DB（永久）；workspace `getOrCreate` 发现原沙箱被回收 → 从 `snapshotId` resume 重建（一次冷启动）→ 文件恢复。边界：snapshot 存文件不存进程。

**TDD 折扣（诚实标注）**：snapshot/resume 的真实验证只能在阶段 5 真接 Vercel 时做；前面阶段测试覆盖「复用/重建/重连的判断逻辑」，LocalSandbox 用 tar 近似快照，但真快照恢复测不到。

## 7. 安全要点

- **隔离**：VercelSandbox 是 Firecracker microVM，与平台代码物理隔离；危险命令只在沙箱内执行。
- **path guard**：文件操作路径归一化后必须落在 workspace 内，否则拒绝（不依赖沙箱本身，接口层就拦）。
- **命令白名单**：`run_command` 默认拒绝高风险命令（`rm -rf /`、sudo、无授权网络）。
- **超时 + 截断**：每次命令有 timeout（AbortSignal），stdout/stderr 截断防上下文爆炸。
- **网络策略**：生产可用 `networkPolicy` 默认禁网、按任务授权（P0 用默认，P1 收紧）。
- **secrets**：env 注入沙箱，不落盘；GitHub 凭证用完即清（Open Agents 模式，本项目 P0 不接 git 写）。

## 8. 落地计划（对应 tasks 阶段）

- **阶段 2**：先实现 `LocalSandbox` + `Sandbox` 接口 + path-guard + 按 session 复用目录，跑通全部工具的 integration 测试（零外部依赖）。
- **阶段 5**：实现 `VercelSandbox` adapter（`getOrCreate` + `snapshot`/resume），本地 `vercel link` + `vercel env pull` 配认证，切 `SANDBOX_PROVIDER=vercel` 跑通真实 microVM 端到端，验证 ①②；部署后生产认证自动。

snapshot/resume 渐进交付：先 ①（persistent 命名沙箱，文件延续）跑通多轮，再 ②（显式 snapshot + resume）做会话恢复——任何时刻都有可交付版本。

## 9. 取舍

- **P0 做**：①persistent 命名沙箱（文件延续）+ ②显式 snapshot/resume（会话恢复）。
- **P0 不做**：③自动 hibernate 生命周期编排（定时休眠/lease/workflow）、多份历史快照、网络策略收紧、git clone/commit。这些写进演进路径（见 `data-model.md` P1）。
- **为什么不一上来就只用 Vercel**：TDD 要求测试零外部依赖；本地 dev 也不该每次都起 microVM。LocalSandbox 保证主链路与测试不被 Vercel 账号/网络阻塞，Vercel 作为生产 adapter 验证隔离与 snapshot 能力。
- **为什么不用 E2B / 其他**：Vercel Sandbox 与本项目部署目标（Vercel）同生态，认证在生产自动完成，且 `persistent` + `snapshot` 原生支持 ①②，接入成本最低。

## 参考来源

- `@vercel/sandbox@2.2.1` 类型定义（本地 node_modules，一手）
- Vercel Open Agents `packages/sandbox`（MIT，封装参考）
- [Vercel Sandbox 文档](https://vercel.com/docs/vercel-sandbox)
- [Vercel Sandbox 定价与限制](https://vercel.com/docs/vercel-sandbox/pricing)
- [Sandbox 支持 32 vCPU / 64GB 配置（changelog）](https://vercel.com/changelog/vercel-sandbox-now-supports-up-to-32-vcpu-64-gb-ram-configurations)
- [Vercel Sandbox vs E2B](https://vercel.com/kb/guide/vercel-sandbox-vs-e2b)

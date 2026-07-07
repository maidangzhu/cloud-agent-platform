# 开发约定 (Development Conventions)

本项目遵循一套明确的开发工作方式。任何人（包括 AI 助手）参与开发都必须遵守。

## 核心规则

1. **分阶段交付，每阶段停下检查**
   - v1（`cloud-agent-platform-mvp`）已归档于 `openspec/changes/archive/2026-07-04-cloud-agent-platform-mvp/`，其状态机/数据模型已被 v2 架构决策推翻，仅作历史存档，不再作为实现参考。
   - v2 实现按阶段推进，阶段划分见 `openspec/changes/v2-research-workspace-agent/tasks.md`（与 `docs/implementation-roadmap.md` 的 21 个 Group / 45 个 Step 一一对应）。
   - **每完成一个任务（tasks.md 中的一个 `- [ ]` 条目），必须停下来，等人工检查通过后，才进入下一个任务。**
   - 不允许一次性铺开多个任务的实现。
   - **提交（git commit）只能在人工检查通过、且明确同意后进行**；不得在未获批准前主动提交。完成一个任务后给出改动摘要，等人工 review，得到「可以提交」的明确指令才 `git commit`。

2. **进度用 OpenSpec 记录**
   - 采用 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 规范驱动开发。
   - v2 变更的 proposal / design / specs / tasks 位于 `openspec/changes/v2-research-workspace-agent/`。
   - specs 只承载"系统应该做什么"（Requirement/Scenario）；决策论证（为什么这么定、被否方案）在 `docs/decisions/`（ADR），不重复写进 spec.md。
   - 每完成一项任务，在 `tasks.md` 中把对应 `- [ ]` 勾选为 `- [x]`。
   - 阶段完成后用 `openspec status --change <name>` 查看进度。

3. **全程测试驱动开发 (TDD)**
   - 每个阶段：**先写测试 → 再实现 → 跑绿**，然后才停下。
   - 确定性逻辑（状态机、path guard、工具边界、事件顺序、agent 编排）必须有测试覆盖。
   - **所有业务流程一律由测试驱动实现**：工具层、agent loop、API 全部用集成测试跑通真实 Vercel 沙箱 + 真实 DB；后端业务测试全绿后才开始前端开发——进入前端时整条业务链已被测试证明可跑。
   - 业务集成测试连真实 Vercel 沙箱 + Neon + 真实 LLM；沙箱**只用真实 VercelSandbox**（无 LocalSandbox）。
   - **分两层测试**：① 纯逻辑单元测试零外部依赖（无 key / 无网络也能全绿）；② 业务集成测试连真实 Vercel 沙箱 + Neon（需 Vercel 凭据与网络，本机被墙时需代理）。

4. **隐私约束（硬性）**
   - 仓库内**不得出现任何个人隐私信息**：人名、公司名、个人电脑路径（如 `<home-directory>/<user>`）、笔试编号、私有仓库地址等。
   - 文档中引用本机参考仓库或工作区时，必须使用 `<reference-root>`、`<repo-root>` 或相对路径；不得写入完整系统路径。
   - demo repo 用中性内容；git author 用中性占位。
   - 提交前执行隐私自检。

## OpenSpec 常用命令

不需要全局安装（不用 `npm install -g`，不写进 `package.json`），直接用 `npx @fission-ai/openspec` 按需调用；npx 会自动缓存（`~/.npm/_npx/`），每次仍是独立解析，不是装好的全局命令，这是预期行为。

```bash
# 查看所有 change 的进度总览（含已完成/总任务数）
npx @fission-ai/openspec list

# 查看当前变更的 artifact 完成状态 + 任务勾选进度
npx @fission-ai/openspec status --change v2-research-workspace-agent

# 校验变更 artifacts 格式
npx @fission-ai/openspec validate v2-research-workspace-agent --type change --strict

# 查看变更的完整结构化内容（含每条 Requirement/Scenario）
npx @fission-ai/openspec change show v2-research-workspace-agent

# 交互式仪表盘（浏览 specs/changes 更直观）
npx @fission-ai/openspec view

# 实现完成后归档变更（specs 合并进 openspec/specs/）
npx @fission-ai/openspec archive v2-research-workspace-agent
```

日常检查进度用 `list`/`status` 就够——`list` 返回的已完成/总任务数直接对应 `tasks.md` 里 `- [x]` 的勾选数，是判断"做到哪了"最可信的信号源。

## v2 Group 总览

详细 Step 拆解见 `docs/implementation-roadmap.md`；下表是粗粒度概览。

| Group | 内容 | 测试层 |
| --- | --- | --- |
| 0-1 | PoC + 文档校订（已完成） | 手动验证 / 文档 review |
| 2 | Monorepo 脚手架（pnpm workspaces + Hono） | 构建可跑 |
| 3-7 | Auth / Workspace / Thread / Run 状态机 / Scoped Token | unit + route |
| 8-12 | Ingest 基线 + Fake Runner + Files/Artifacts/Sources | route + integration（fake runner） |
| 13-15 | Token Stream 转发 + LLM Proxy + Search Proxy/工具协议 | integration（真 Redis / fake provider） |
| 16 | 真实 Sandbox Agent Loop | integration（真沙箱） |
| 17-18 | Usage 遥测 + Sweep | integration |
| 19-20 | UI Shell + Browser E2E | component + e2e |
| 21 | 部署和运维 | 手测 + 生产验证 |

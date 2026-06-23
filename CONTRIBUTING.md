# 开发约定 (Development Conventions)

本项目遵循一套明确的开发工作方式。任何人（包括 AI 助手）参与开发都必须遵守。

## 核心规则

1. **分阶段交付，每阶段停下检查**
   - 实现按阶段推进，阶段划分见 `openspec/changes/cloud-agent-platform-mvp/tasks.md`。
   - **每完成一个阶段（tasks.md 中的一个 `##` 分组），必须停下来，等人工检查通过后，才进入下一阶段。**
   - 不允许一次性铺开多个阶段的实现。

2. **进度用 OpenSpec 记录**
   - 采用 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 规范驱动开发。
   - 变更的 proposal / design / specs / tasks 位于 `openspec/changes/cloud-agent-platform-mvp/`。
   - 每完成一项任务，在 `tasks.md` 中把对应 `- [ ]` 勾选为 `- [x]`。
   - 阶段完成后用 `openspec status --change <name>` 查看进度。

3. **全程测试驱动开发 (TDD)**
   - 每个阶段：**先写测试 → 再实现 → 跑绿**，然后才停下。
   - 确定性逻辑（状态机、path guard、工具边界、事件顺序、agent 编排）必须有测试覆盖。
   - **所有业务流程一律由测试驱动实现**：工具层、agent loop、API 全部用集成测试跑通真实 Vercel 沙箱 + 真实 DB；后端业务测试全绿后才开始前端开发——进入前端时整条业务链已被测试证明可跑。
   - LLM 的不确定性用 pi-ai 内置的 `registerFauxProvider` 脚本化（保证测试确定性）；沙箱**只用真实 VercelSandbox**（无 LocalSandbox）。
   - **分两层测试**：① 纯逻辑单元测试零外部依赖（无 key / 无网络也能全绿）；② 业务集成测试连真实 Vercel 沙箱 + Neon（需 Vercel 凭据与网络，本机被墙时需代理）。

4. **隐私约束（硬性）**
   - 仓库内**不得出现任何个人隐私信息**：人名、公司名、个人电脑路径（如 `/Users/<name>`）、笔试编号、私有仓库地址等。
   - demo repo 用中性内容；git author 用中性占位。
   - 提交前执行隐私自检。

## OpenSpec 常用命令

```bash
# 查看当前变更进度
npx @fission-ai/openspec status --change cloud-agent-platform-mvp

# 校验变更 artifacts 格式
npx @fission-ai/openspec validate cloud-agent-platform-mvp --type change --strict

# 实现完成后归档变更（specs 合并进 openspec/specs/）
npx @fission-ai/openspec archive cloud-agent-platform-mvp
```

## 阶段总览

| 阶段 | 内容 | 测试层 |
| --- | --- | --- |
| 0 | 地基（依赖 + 配置） | 构建可跑 |
| 1 | 纯逻辑层（状态机/path guard/policy/事件序） | unit |
| 2 | 工具层 + VercelSandbox | integration（真沙箱） |
| 3 | Agent loop 编排（faux LLM） | integration |
| 4 | API 路由 | route tests |
| 5 | UI + 真实接入 + 部署 + 文档 | e2e + 手测 |

接手 /Users/zhujianye/maidang/cloud-agent-platform，分支 v2/research-workspace-agent。

第一步：请先读 docs/handoff-2026-07-10.md ——这是给你的完整交接说明，包含项目背景、当前所处阶段、这一轮做了什么、还没做完什么、以及一次判断失误的教训。读完之后简单跟我确认你理解了现在的状态和接下来的优先级，再开始动手。

简要背景（handoff 文档里有详细版本）：

- 当前处于"架构分层测试收敛"阶段，不是继续赶完整链路。docs/architecture-test-plan.md 定义了 6 层测试顺序：Control Plane → Sandbox Substrate → Runtime Tools → Redis Streaming → Workspace Mapping → Full Product Path。原则是每层先自己测扎实，再进下一层。
- 上一轮已经把 Control Plane 里 Run 状态机、Event Store、RunToolCall 状态转移、Artifact 创建这几个子模块过了一遍，方法是：先读代码讲清楚设计，复核现有测试是否真覆盖到并发场景（很多"先查后写"式代码只被串行测试覆盖过，没有真并发测试），补 Promise.all 并发测试验证，发现问题就修。这个方法论一共揪出 3 个真实的生产 bug（都已修复并提交，commit bb40e1d）：
  1. Event Store 并发写入同一个 seq 时的边界判断错误 + Prisma 异常类型判断错误导致的异常穿透。
  2. RunToolCall 状态转移的并发终态上报会静默"最后写入者赢"，两次请求都返回 200，没有任何信号暴露数据损坏——这是最严重的一个。
  3. Artifact 创建的并发防御缺失（目前配置下不会触发，但做了防御性修复）。
- 也有一次判断失误：曾经误判"同一 thread 只能一个活跃 run"是后端缺失的强制规则，改代码后导致 67 个测试失败，查证据后确认产品设计本来就允许同一 thread 内多个连续 run（Stage1/Stage2 机制），已撤回。这个教训写在 handoff 文档里，值得看一下——核心是"不要凭读代码的印象直接改生产代码，先补测试验证现状"。

接下来的优先级（按 handoff 文档 §4）：

1. Auth/Ownership 边界——还没细看，是权限控制的地基。
2. SSE/Redis 边界（CP-SSE-005/CP-TOOL-005）——明确的 gap：tool call 生命周期从来没写进 RunEvent，SSE 上看不到工具调用时间线。docs/architecture-test-plan.md §4.4a 有详细缺口分析和修复思路。
3. LLM/Search 代理、Files/Sources、Sweep——还没系统性复核并发安全，按同样方法论过一遍。

明确不要碰的（有意排到后面）：
- Pi runtime thinkingLevel 硬编码为 "off"（v2-research-workspace-agent/tasks.md 22.11）。
- Pi runtime LLM proxy 目前 stream:false，不是真流式（22.12）。
这两条排在"Control Plane tool timeline 收敛之后"，本轮不做。

工作方式要求：
- 每个任务做完停下来，等我确认，不要连续做多个不停顿。
- 只有我明确检查通过才 commit，不要主动提交。
- 改动前先跑测试验证现状，不要凭读代码的印象直接改生产代码。
- 每次改动后跑：pnpm --filter @cap/api typecheck、pnpm --filter @cap/api test、pnpm --filter @cap/api test:integration（需要 .env 里的 DATABASE_URL）、npx @fission-ai/openspec validate <change-name> --type change、git diff --check。
- 不要用"完整链路能跑"代替模块测试。

先读完 handoff 文档并确认理解，我们再决定具体从哪个子模块开始。

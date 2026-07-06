# 测试理念 — 状态空间、真实边界和风险驱动

这份文档说明我们为什么这样设计测试。具体测试分层、命令和用例清单见 [testing-strategy.md](./testing-strategy.md)。

## 1. 核心目标

这个项目不是普通 CRUD。它的高风险点在于：

- agent loop 在真实 sandbox 内执行。
- 状态通过 Control Plane、Redis Streams、Postgres、SSE、LLM/Search provider 多边界流动。
- LLM 输出不完全可预测，但平台协议必须可预测。
- run/sandbox/tool/artifact/source 都有状态机和并发竞态。
- 用户看到的是连续体验，但系统内部是异步、可断线、可重试、可恢复的。

因此测试的目标不是“证明几个 happy path 能跑”，而是证明：

- 所有关键状态最终收敛。
- 所有边界有明确权限和数据契约。
- 重连、重试、fallback、timeout、cancel 不破坏事实源。
- 真实 provider 和真实 sandbox 的行为不会让协议层失控。
- UI 只是事实源的呈现，不承担修正后端状态的责任。

## 2. 专业测试工程师的视角

专业测试工程师不会先问“这个函数怎么测”，而会先问：

1. 系统有哪些状态机？
2. 哪些状态转移是合法的，哪些必须拒绝？
3. 哪些边界会丢数据、重复数据、越权、超时或乱序？
4. 哪些外部依赖不可靠？
5. 失败后用户和系统分别应该看到什么？
6. 哪些 bug 一旦发生就不可接受？

这意味着测试设计要从模型开始，而不是从代码文件开始。

## 3. 测试 Oracle

LLM 文本本身通常不是稳定 oracle。我们不应该把“模型回答了某个固定句子”作为核心断言。

稳定 oracle 应该是：

- Run status 是否正确。
- Event seq 是否单调、幂等、无冲突。
- SSE / Redis chunk 是否不丢、不重、顺序正确。
- thinking/content 是否走 stream chunk，语义事件是否低频落库。
- tool call 是否作为完整对象出现，不被 token 化。
- file/artifact/source 是否正确落库并可查询。
- artifact version 是否符合规则。
- usage telemetry 是否记录 provider/model/tokens/duration。
- fallback/retry/timeout 是否按策略发生。
- sandbox 是否只拿 scoped run token，没有 DB/Redis/长期 provider key。

对于真实 LLM，测试重点是协议和系统反应，而不是自然语言措辞。

## 4. 状态机优先

凡是能画成状态机的东西，都应该按状态空间测。

核心状态机：

- Run：created / provisioning_sandbox / running / waiting_for_input / cancel_requested / completed / failed / cancelled / timeout / interrupted。
- SandboxInstance：provisioning / pending / ready / warm / stopped / failed。
- ToolCall：running / completed / failed / rejected。
- Artifact：created / updated / versioned。
- SSE cursor：snapshot / live / reconnect / done。
- Provider call：started / first_token / retry / fallback / success / failure / timeout。

状态机测试分三类：

- 合法转移必须成功。
- 非法转移必须拒绝。
- 并发转移只能有一个赢家，terminal 状态不能被覆盖。

## 5. 边界优先

本系统最容易出问题的不是单个函数，而是边界：

- Browser -> Control Plane。
- Control Plane -> Postgres。
- Control Plane -> Redis Streams。
- Control Plane -> Vercel Sandbox。
- Sandbox -> Control Plane ingest。
- Sandbox -> LLM/Search proxy。
- LLM/Search proxy -> real provider。
- API/SSE -> UI state。

每个边界至少要测：

- 鉴权：谁能调用，token scope 是什么。
- 数据契约：请求/响应 shape、错误码、幂等键。
- 时序：先后顺序、重试、断线、超时。
- 失败：4xx、5xx、timeout、partial response。
- 资源清理：terminal 后是否释放 sandbox、Redis key 是否过期、DB 是否无孤儿状态。

## 6. 真实路径和真实依赖

我们把“真实”拆成几种，不混用：

- Local API：服务在本地或进程内，但可以连真实 Neon/Redis/Vercel Sandbox。
- Deployed API：服务是公网部署，sandbox 可以从 microVM 回调它。
- Real Provider：真实 OpenAI/Anthropic/Exa/Vercel Sandbox 等。
- Browser E2E：真实浏览器驱动 UI。

如果测试目标写着 sandbox，它必须使用真实 Vercel Sandbox。进程内 helper 只能叫 fixture，不能算 sandbox coverage。

如果测试目标写着 deployed callback，它必须打公网 API base URL，不能用 `app.request()`。

## 7. Workflow Tests 的角色

Workflow tests 是最重要的一层：不开浏览器，但走完整产品主流程。

它们应该回答：

- 一个真实 run 从创建到终态是否完整闭环？
- 中途 waiting_for_input、cancel、timeout、tool failure 是否都能收敛？
- Redis stream 和 DB event store 的双通道是否一致？
- sandbox 内 agent 是否只能通过 ingest/API 影响事实源？
- 重连后用户是否看不到丢失或重复？

Workflow tests 不是 smoke。它们应该覆盖主流程中的状态分支。

## 8. Live / Expensive Tests 的角色

Live / Expensive tests 是允许花钱买确定性的测试层。

它们应该覆盖便宜测试无法真实覆盖的风险：

- 真 provider 首 token 延迟。
- provider 429/5xx/timeout。
- fallback 到第二 provider。
- retry 后成功和 retry 耗尽。
- 长上下文成本和截断策略。
- real Exa 搜索质量和响应 shape。
- Vercel Sandbox 冷启动、复用、exec 超时。
- deployed API 的 cookie/CORS/SSE/runtime 差异。

这类测试可以慢，可以贵，但必须有明确断言和运行频率，不能变成随手调 API。

## 9. LLM 测试方法

LLM 模块要分层测：

- Provider adapter：不同 provider 的响应归一化。
- Policy：model selection、fallback、retry、timeout、first-token SLA。
- Streaming：thinking/content chunk、tool call 完整对象、finish reason。
- Context：超大上下文、截断、压缩、拒绝。
- Usage：tokens、duration、provider、model、fallback metadata。
- Workflow：LLM 输出驱动工具、artifact、source、waiting_for_input。
- Live：真实 provider 的慢响应、限流、断流、异常格式。

LLM 测试的断言不应依赖大段自然语言。应该断协议事实：

```text
firstTokenMs < threshold
fallbackProvider == expected
toolCalls.length == expected
thinkingChunks were streamed
agent_thinking persisted once after semantic boundary
usage.provider/model/tokens recorded
run reached completed/failed with expected error code
```

## 10. Sandbox 测试方法

Sandbox 模块要分层测：

- 创建：首次创建、按 workspace 命名、凭证缺失、provider 失败。
- 复用：warm/ready/stopped 复用，并发只允许一个 run claim。
- 注入：manifest、agent loop script、workspace files、未来 snapshot。
- 执行：node/bash/tool command、stdout/stderr 截断、timeout。
- 隔离：无 DB/Redis/provider key、无 Better Auth cookie、路径不能越界。
- 回调：sandbox -> deployed Control Plane ingest/stream-chunk/llm-proxy/search-proxy。
- 危险操作：删除文件、访问私有网络、长时间命令、超大输出。
- 收敛：cancel、timeout、sweep、orphan sandbox cleanup。

Sandbox 测试必须明确区分：

- “写脚本到真实 sandbox 并 exec 成功”。
- “sandbox 内脚本能回调公网 API”。
- “sandbox 内 agent loop 完成完整 workflow”。

这三者不是同一个覆盖点。

## 11. 测试用例元数据

新增重要测试时，建议在测试名或注释中明确这些维度：

```text
level: unit | route | component-integration | workflow | browser-e2e | live-expensive
environment: local-api | deployed-api
providers: fake-llm | real-llm | real-exa | real-vercel-sandbox
cost: cheap | paid | expensive
frequency: pr | nightly | manual
risk: state-machine | auth | data-loss | duplicate | timeout | fallback | security
```

不是每条测试都要写完整 metadata，但 paid/live/workflow 测试必须让读代码的人看出它为什么存在、覆盖哪个风险。

## 12. 覆盖完整性的判断

判断“够不够全”时，不看测试数量，先看覆盖矩阵：

- 每个状态是否有进入和退出测试。
- 每个 terminal 状态是否有防覆盖测试。
- 每个外部边界是否有成功、失败、超时、重试测试。
- 每个异步流是否有断线、重连、重复、空洞测试。
- 每个权限边界是否有越权测试。
- 每个资源是否有创建、复用、释放、清理测试。
- 每个真实 provider 是否至少有 smoke 和 live-expensive 覆盖。
- 每条主 workflow 是否有 happy path 和关键失败分支。

如果一个 bug 会导致用户数据丢失、重复收费、越权、run 永久卡住、sandbox 持续计费或 UI 展示错误事实，它必须有测试。

## 13. 运行策略

默认策略：

```text
PR:
  unit + route + cheap component integration

Nightly:
  full component integration + workflow + selected live provider tests

Manual release gate:
  deployed API workflow + live-expensive matrix + browser E2E
```

本项目可以接受 paid/nightly/manual 测试成本。成本不是跳过关键边界测试的理由；成本只决定运行频率。


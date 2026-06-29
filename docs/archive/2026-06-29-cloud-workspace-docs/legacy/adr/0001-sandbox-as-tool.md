# ADR-0001：Agent 与 Sandbox 的关系 —— Sandbox as Tool

- 状态：已采纳
- 日期：2026-06
- 相关：[`architecture.md`](../architecture.md)、[`sandbox-research.md`](../sandbox-research.md)

## 背景

题目要求构建 Cloud Agent Platform：用户提交自然语言任务，平台启动自主 agent，在云端隔离环境中调用 LLM、调用工具、循环迭代、返回结果。考点为 Agent 编排调度、沙箱隔离、LLM 集成与工具调用、架构可扩展性。

「agent 与 sandbox 的关系」有两种对立范式，必须先定，因为它决定整个系统拓扑：

### 范式 A：Sandbox as Tool

```
Server (Function/进程)              ← agent loop 在这里
  Pi Agent loop：模型推理 + 循环控制 + 落库
    └─ 工具 execute() ──exec()──> Sandbox（只执行 shell / 读写文件）
```

agent 的「大脑」（LLM 推理、loop、编排、落库）在 server；沙箱只是工具伸手进去执行副作用的隔离环境。代表：Vercel Open Agents。

### 范式 B：Agent in Sandbox

```
Server                              Sandbox
  你的 app ──HTTP/SSE──> [ 常驻 daemon + Claude Code/Codex/Pi 进程 ]
```

整个 coding agent 进程（连同 loop、transcript）跑在沙箱内，一个常驻 daemon 暴露 HTTP/SSE，server 只做远程控制。代表：sandbox-agent（Rust daemon，支持 Docker/E2B/Daytona/Modal/Cloudflare/Vercel 等 provider；Vercel 下通过 `runCommand(detached)` + 暴露端口 + `domain()` 实现）。

## 决策

**采用范式 A（Sandbox as Tool）。** 范式 B 作为演进方向与对照写入文档，P0 不实现。

## 理由

1. **题目不要求整个 agent 进程跑在沙箱里**。原文要在隔离环境执行的是「调用工具（执行命令、读写文件）」即副作用，不是 agent 的推理大脑。范式 A 中所有 `run_command / read_file / write_file` 都在沙箱执行，**已满足「云端隔离执行」**。Claude Code Cloud / Devin 的类比里，编排控制面同样在沙箱之外。

2. **正面命中「Agent 编排与调度」考点**。范式 A 让我们自己实现 loop、状态机、工具调度、policy guard；范式 B 把编排外包给现成 agent，平台退化为远程控制器，编排能力反而无法展示。

3. **状态三边界清晰**（平台状态/执行状态/runtime 状态），是本方案核心卖点。范式 B 中 transcript 在沙箱内产生，必须靠 daemon 流式导出才能落库——这正是 sandbox-agent 项目存在的理由，对本题是额外复杂度。

4. **「可扩展性」讲得更好**。以 A 为 P0，可在文档中清晰展开演进：P1 抽到独立 worker/queue，P2 甚至可演进到 agent-in-sandbox。展示架构判断力比直接堆复杂度更有价值。

5. **24h 工期下的工程现实**。范式 B 的最小可用版本必须先打通「沙箱内常驻 daemon + 远程控制 + 事件归一化导出 + 落库」才能见到第一个 demo；范式 A 中沙箱只需能 `exec`/读写文件，用统一 `Sandbox` 接口接 Vercel microVM 即可跑通主链路，工程量小得多。

## 范式 B 的坑（A 全部规避）

| 范式 B 必须解决 | 范式 A 的情况 |
| --- | --- |
| session transcript 在沙箱内 → 沙箱↔DB 同步 | loop 在 server，transcript 直接落 DB |
| 沙箱初始化/还原（snapshot / resume 冷启动） | 沙箱只需能 exec，无需还原运行态 |
| 沙箱内常驻 daemon 的生命周期 / 健康检查 / HTTP 通信 / 装 agent CLI | 无 daemon，沙箱接口仅 exec/read/write |
| LLM key 注入沙箱的安全处理 | key 留在 server，不进沙箱 |

## 范式 B 的可取之处（写入演进）

范式 B 解决了范式 A 的一个真实痛点：**A 的 loop 绑定 HTTP 请求生命周期，用户关闭页面或函数超时则 loop 停止**。同一问题三种解法：

- Open Agents：durable workflow（loop 在 workflow，跨请求持久）
- sandbox-agent：daemon in sandbox（loop 在沙箱内进程，独立于 HTTP）
- 本项目 P0：Function 内联 + 心跳兜底（关页面则 loop 停，靠 DB 事件恢复观察）

「agent 进程独立于 HTTP 生命周期」是本项目 **P1 演进**的候选方向之一。

## 结论

P0 采用 Sandbox as Tool：agent loop 在 server（Pi），沙箱经统一 `Sandbox` 接口被当作受控工具执行后端（唯一实现 VercelSandbox，业务测试与生产共用真实 microVM）。

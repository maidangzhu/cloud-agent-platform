# ADR-0017：Token 攒批的位置与落库时机——沙箱内存攒、语义边界触发落库

**状态：** 已接受（2026-07-03）

## 决策

补全 [ADR-0011](./0011-dual-channel-streaming.md)（双通道流）和 [ADR-0016](./0016-token-stream-relay-redis-pubsub.md)（Redis 转发）之间的一个空白：token 流转发的同时，"攒批"发生在哪里、"落库"在什么时机触发。

**攒的地方：沙箱内 agent loop 进程的内存里，一个普通字符串变量（如 `accumulatedText`）。** 不落盘、不进数据库、不进 Redis——纯内存拼接，跟一般代码里 `text += token` 没有区别，没有任何专门机制。

**落库的触发条件：LLM 协议本身自带的语义边界出现时（如 `finish_reason` 出现 / thinking 切到 content 阶段 / `TEXT_MESSAGE_END`），不是按时间间隔或 token 数量切。**

沙箱 agent loop 收到每个 token 时并行做两件事：

```
①（转发路径，ADR-0016）立刻 PUBLISH 到 Redis 频道 → 前端立刻看到这个字，全程不落库
②（攒批）accumulatedText += token（纯内存操作）

当 LLM signal"这段完整了"：
③（落库路径，ADR-0011）调一次 POST /api/ingest/events，把 accumulatedText 整段传过去落库
   → 清空 accumulatedText，如果还有下一段（如下一轮 thinking），重新开始攒
```

按数据类型的具体落库时机：

- **thinking（推理内容）**：模型从"推理阶段"切到"输出阶段"的转折点，整段 thinking 落一次 `AgentEvent`。
- **content（正式回复文字）**：这轮回复完全说完（`TEXT_MESSAGE_END`）时，整段回复落一次，通常同时创建一条 `Message` 记录。
- **tool call**：不走"攒批"这条路。工具调用本身不是逐字吐出来的——LLM 决定调用工具时是一次性给出完整的工具名+参数（本身就是完整对象），收到即完整，直接落库（`tool_call_started` 带完整参数，执行完再落一次 `tool_call_completed` 带完整结果）。

## 为什么落库次数不会暴涨

落库次数只跟"发生了几次语义完整的事件"成正比，跟 token 总量无关。一次典型的 Stage 2 深挖（[ADR-0013](./0013-mechanism-deep-dive-refinement.md)），可能有 1 次 thinking 开场、20 次工具调用、5 段独立 thinking/content、最后 1 次完整回复——对 DB 的写入量级是"25 次左右"，不是"这次 run 吐了 3 万个 token，所以写了 3 万次库"。这正是 [ADR-0011](./0011-dual-channel-streaming.md) 当初否掉"每 token 都落库"方案的原因（"每 token 走一趟写库，延迟毁掉流式体验"）——本 ADR 明确了具体机制，确保这个原则不会在实现时被绕过。

## 背景

ADR-0011 定了"token 流不落每个 token、落最终聚合整段"，ADR-0016 解决了"怎么把 token 实时转发给不同实例上的前端"，但两者之间"攒批发生在系统的哪个具体位置、触发落库的具体条件是什么"一直没有被明确写下来，是纯口头讨论的产物。补齐这个空白，避免实现时对"攒"这个动作该放在沙箱侧还是 Control Plane 侧产生歧义（正确答案是沙箱侧，因为沙箱是唯一持续拿到 LLM 流式响应的地方，Control Plane 只是转发中继，没有必要也不应该在 Control Plane 侧再做一次攒批）。

## 被否方案

- **按固定时间间隔或固定 token 数量攒批落库（如每 200ms 或每 N 个 token 落一次）：** 讨论过程中一度考虑，被否——这类阈值是任意的、跟语义无关，可能在一段 thinking 中间任意切断落一条不完整的记录，且没有必要：语义边界本身就是天然、精确、免费可用的触发信号。
- **在 Control Plane 侧攒批：** Control Plane 只是转发中继（通过 Redis 订阅收到 token），不是 token 的原始来源，让它重复做一次沙箱已经做过的攒批毫无必要，且会引入"两处状态需要保持一致"的额外复杂度。

## 连锁影响

- **agent-runtime-protocol.md**：第 5.3 节 agent loop 伪代码需要补充"沙箱侧维护 accumulatedText、检测语义边界触发 ingest"这一层细节；第 9 节 LLM Proxy 契约的响应格式需要明确 runner 侧如何识别"这段完整了"（如依赖 provider 的 `finish_reason` 字段，防腐层 [ADR-0009](./0009-provider-anti-corruption-layer.md) 需要保证这个信号在不同 provider 间被归一化，不能让 runner 直接处理 provider 差异）。

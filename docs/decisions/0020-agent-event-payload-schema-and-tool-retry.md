# ADR-0020：AgentEventDTO.payload 判别联合 schema；web_search/fetch_url 失败重试协议；search proxy 端点（解决 DQ-3）

**状态：** 已接受（2026-07-03）

## 决策

### 1. AgentEventDTO.payload 按 type 定义判别联合（discriminated union）

替换 [api-contract.md](../api-contract.md) 现有的 `payload?: unknown` 占位。核心要求：**thinking/content（走 [ADR-0017](./0017-token-accumulation-and-persistence-timing.md) 攒批落库路径）和 tool_call（一次性完整对象）不能共用同一套 payload 字段**，否则 Run Timeline 和测试断言都没法精确针对每种事件类型写期望值。

```ts
type AgentEventPayloadMap = {
  run_created: null;
  sandbox_provisioning: null;
  sandbox_ready: null;
  runner_started: null;
  agent_started: null;

  // ADR-0017：语义边界触发落库，thinking/content 各自在完整时落一次。
  // 完整文本放 AgentEventDTO.content，payload 只带辅助信息。
  agent_thinking: { model?: string };
  agent_message: { messageId: string };

  // tool_call：一次性完整对象，不走攒批路径。
  tool_call_started: { toolCallId: string; name: string; args: unknown };
  tool_call_completed: { toolCallId: string; name: string; result: unknown; durationMs?: number };
  tool_call_failed: { toolCallId: string; name: string; error: string; durationMs?: number };

  file_written: { fileId: string; path: string; size: number; contentHash: string };
  source_recorded: { sourceId: string; kind: SourceDTO["kind"]; uri?: string; title?: string };

  artifact_started: { artifactId: string; title: string; kind: ArtifactDTO["kind"] };
  artifact_delta: { artifactId: string; deltaText: string };
  artifact_created: { artifactId: string; title: string; kind: ArtifactDTO["kind"]; version: number };
  artifact_updated: { artifactId: string; title: string; kind: ArtifactDTO["kind"]; version: number; previousVersion: number };
  artifact_failed: { artifactId?: string; error: string };

  run_completed: { totalTokens?: number; durationMs: number };
  run_failed: { errorCode?: string };
  run_timeout: { lastHeartbeatAt?: string };
  run_cancelled: null;
  run_waiting_for_input: { question: string; options?: string[] };
};

type AgentEventDTO<T extends keyof AgentEventPayloadMap = keyof AgentEventPayloadMap> = {
  seq: number;
  type: T;
  role?: string;
  title?: string;
  content?: string;
  payload: AgentEventPayloadMap[T];
  createdAt: string;
};
```

`model_step`（旧的含糊类型）被 `agent_thinking`/`agent_message` 取代；旧文档记录不删除，在协议文档里注明"已被更具体的类型取代"。

`IngestEventRequest`（[api-contract.md](../api-contract.md) §6.1）的 `payload` 字段服务端必须按 `type` 校验形状是否匹配对应 schema——这条校验规则本身产生一批新的 route test 断言点（见测试用例清单）。

### 2. artifact_updated 与 artifact_created 的区分规则

`POST /api/ingest/artifacts` 请求带的 `artifactId`：

- 留空或指向不存在的 id → 首次创建，`version = 1`，产生事件 `artifact_created`。
- 指向已存在的 artifact → 新版本（`version + 1`），产生事件 `artifact_updated`。

这条规则修复了 memory 记录的文档漂移（frontend-vercel-chatbot-reference.md 定义了 `artifact_updated`，agent-runtime-protocol.md §7 事件类型列表漏了它）——现在两侧统一，agent-runtime-protocol.md §7 补上该类型。

### 3. web_search 工具协议（新增 agent-runtime-protocol.md §8.4；解决 [DQ-3](./OPEN-QUESTIONS.md)）

必须经 Control Plane 代理，provider key（如 Brave）不进沙箱：

```text
build query params
POST /api/search-proxy （scoped run token）
Control Plane 持有 provider key，调用真实 search API
Control Plane 记录调用量（同 ADR-0015 usage telemetry 思路，落一条 LLMUsageRecord 同构记录）
Control Plane 返回归一化结果列表
```

新增端点 `POST /api/search-proxy`（补入 [api-contract.md](../api-contract.md) §7，与 LLM Proxy 并列）：

```ts
type SearchProxyRequest = { query: string; limit?: number };
type SearchProxyResult = { url: string; title: string; snippet?: string };
type SearchProxyData = { results: SearchProxyResult[] };
```

规则：

- 超时 10s。
- 网络失败/5xx 最多重试 2 次，指数退避（500ms / 1500ms）——search 请求本身幂等，可以重试。
- provider 返回 4xx（查询被拒/quota 用尽）不重试，直接产生 `tool_call_failed`。
- 结果里每条 url 如果之后被 `fetch_url` 抓取，记为 `Source`（`kind = search_result`）。
- HTML/结果清洗放在 sandbox runner 侧（不是 Control Plane 服务），Control Plane 只做代理转发和 key 托管。

### 4. fetch_url 工具协议（新增 agent-runtime-protocol.md §8.5）

Sandbox 直接发起，不经代理（不需要密钥，`toolPolicy.allowNetwork` 已经覆盖了这一层信任边界）：

```text
validate url scheme（仅 http/https）
SSRF guard：拒绝 localhost / 127.0.0.1 / 内网 CIDR（10.x, 172.16.x, 192.168.x, 169.254.x）/ 云 metadata 地址
fetch content
truncate to size limit（如 5MB），超限标记 truncated: true
非文本 content-type 只记录 metadata，不解析全文
record_source（kind = url），不论是否被最终引用——这是 ADR-0013 措辞纪律要求的证据链完整性
```

规则：

- 超时 15s（网页比 API 慢）。
- 网络级失败（connect timeout / DNS 失败 / 5xx）最多重试 1 次（抓取成本比 search 高，1 次够处理瞬时抖动）。
- 4xx 或 SSRF guard 触发不重试，`ToolCall.status = rejected`（policy 拦截），不是 `failed`（执行报错）——这条区分对齐 [state-machines.md](../state-machines.md) §6 `ToolCallStatus` 已有的 rejected/failed 语义。

## 背景

三路 Explore 扫描发现两个独立缺口：（a）`AgentEventDTO.payload` 从始至终是 `unknown`，Run Timeline 前端渲染和后端测试断言都没法精确定义每种事件的数据形状；（b）P0 核心工具 `web_search`/`fetch_url` 是协议文档里唯一没写行为规范（超时/重试/失败分类）的部分，且 `web_search` 涉及密钥托管这层信任边界，之前完全没设计对应的代理端点（即 DQ-3）。这条 ADR 一次性补齐两者，因为 payload schema 必须覆盖 tool_call_failed 这类事件，天然要求先确定失败分类规则（rejected vs failed vs timeout）。

## 被否方案

- **payload 用单一宽松 schema（如 `{ message?: string; data?: unknown }`）覆盖所有事件类型**：等于没有 schema，测试仍然没法写具体断言，违背这条 ADR 的初衷。
- **web_search 结果清洗放 Control Plane 服务侧**：Control Plane 应该保持"代理+计量"的薄职责，HTML 清洗/摘要属于 agent 任务逻辑，理应和其他 agent 侧处理（如 fetch_url 的截断）放在同一层，减少 Control Plane 承担的业务逻辑面。
- **fetch_url 也走代理**：`fetch_url` 不需要密钥，直接暴露给 sandbox 网络访问即可，代理化只会增加一次不必要的中转，且 `toolPolicy.allowNetwork` 本身就是为这类工具设计的信任边界控制点。

## 连锁影响

- `api-contract.md`：`AgentEventDTO`/`IngestEventRequest` 的 payload 定义整体替换；新增 §7.x `POST /api/search-proxy` 端点定义；`IngestArtifactRequest` 规则补充 version/artifact_updated 判定逻辑。
- `agent-runtime-protocol.md` §7：事件类型列表新增 `artifact_updated`；§8 新增 8.4 web_search、8.5 fetch_url 两节。
- `state-machines.md` §6：`ToolCallStatus` 必测用例补充"SSRF guard 触发产生 rejected 而非 failed"。
- `docs/decisions/OPEN-QUESTIONS.md`：DQ-3 移除，标记为已解决并链接本 ADR。
- testing-strategy.md：新增 payload 形状校验的 route test 类别；新增 web_search/fetch_url 的重试/超时/SSRF 专项测试。

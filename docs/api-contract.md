# 接口契约 (API Contract) — Cloud Agent Platform

> 本文件定义前后端之间的**接口规范**：统一响应结构、错误码、SSE 事件格式、各端点的请求与数据形状。
> 阶段 4（API 实现）与阶段 5（前端）都**必须遵守本规范**，并据此编写测试。
> 类型与 helper 的权威实现见 [`src/lib/api-contract.ts`](../src/lib/api-contract.ts)（前后端共用，单一事实源）。

## 1. 统一响应信封

除 SSE 外，所有 HTTP 接口返回统一 JSON 信封：

```ts
interface ApiResponse<T> {
  code: number;     // 0 = 成功；非 0 = 业务错误码（见 §3）
  message: string;  // 人类可读信息；成功时通常为 "ok"
  data: T | null;   // 成功时为业务负载；失败时为 null
}
```

- **`code`**：供前端**精确分支**（如 1002 → 跳邀请码页）。`0` 恒为成功。
- **HTTP status**：同时设置且语义化（见 §3），供通用拦截器/中间件处理（如 401 统一登出）。`code` 与 status 并行——前端可只看 `code`，基础设施可只看 status。
- **`data`**：成功时为该端点定义的负载；失败时为 `null`。

成功示例：
```json
{ "code": 0, "message": "ok", "data": { "sessionId": "ck..." } }
```
失败示例（HTTP 401）：
```json
{ "code": 1002, "message": "邀请码无效", "data": null }
```

## 2. 构造约定（服务端）

服务端一律用 helper 构造，不手写信封：

```ts
ok(data, message?)            // → { code: 0, message: "ok", data }
fail(code, message, status?)  // → { envelope, status }；status 缺省由 code 推导
```

具体见 `src/lib/api-contract.ts`。Route Handler 返回 `Response`（`apiJson(envelope, status)`）。

## 3. 错误码与 HTTP status

`code` 分段：`0` 成功；`1xxx` 客户端/请求类；`2xxx` 业务状态类；`5xxx` 服务端。

| code | 含义 | 建议 HTTP status |
| --- | --- | --- |
| 0 | 成功 | 200 |
| 1001 | 请求参数错误（校验失败） | 400 |
| 1002 | 邀请码无效 / 未授权 | 401 |
| 1003 | 资源不存在 | 404 |
| 1004 | 状态冲突（如重复操作） | 409 |
| 2001 | Run 已处于终态，无法取消 | 409 |
| 2002 | Workspace 准备失败 | 422 |
| 5000 | 服务端内部错误 | 500 |

> 新增错误码在 `src/lib/api-contract.ts` 的 `ApiCode` 集中登记，前端从同一处引用。

## 4. 视图 DTO（data 的基本形状）

接口返回的是**视图 DTO**，不是裸数据库行（隐藏内部字段、统一时间为 ISO 字符串）。核心 DTO（权威定义见 `api-contract.ts`）：

```ts
interface SessionDTO   { id; title; status; createdAt; updatedAt; }
interface MessageDTO   { id; role: "user" | "assistant"; content; runId?; createdAt; }
interface RunDTO       { id; sessionId; status; userPrompt; derivedUiState;
                         startedAt?; completedAt?; error?; createdAt; }
interface AgentEventDTO{ seq; type; role?; title?; content?; createdAt; }
interface ToolCallDTO  { id; name; status; args; result?; error?; eventSeq; }
interface ArtifactDTO  { id; kind; title?; path?; content?; createdAt; }
```

**`derivedUiState`**（由 status + 心跳新鲜度推导，见 architecture §8）取值：
`idle | running | possibly_running | interrupted | completed | failed | cancelled | timeout`。

## 5. 端点目录（请求 → data 形状）

> 路径与方法对应 tasks.md 阶段 4。下表为契约骨架；字段细节以 `api-contract.ts` 类型为准。

| 方法 | 路径 | 请求体 | 成功 data |
| --- | --- | --- | --- |
| POST | `/api/invite` | `{ code }` | `{ valid: true }` |
| POST | `/api/sessions` | `{ inviteCode, prompt? }` | `SessionDTO` |
| GET | `/api/sessions/:id` | — | `{ session: SessionDTO; messages: MessageDTO[]; runs: RunDTO[] }` |
| POST | `/api/sessions/:id/runs` | `{ prompt }` | `{ run: RunDTO }`（异步触发，事件走 SSE） |
| GET | `/api/runs/:id` | — | `{ run: RunDTO; events: AgentEventDTO[]; toolCalls: ToolCallDTO[]; artifacts: ArtifactDTO[] }` |
| POST | `/api/runs/:id/cancel` | — | `{ run: RunDTO }` |
| GET | `/api/runs/:id/events` | — | **SSE**（见 §6，不套信封） |

## 6. SSE 事件契约（`GET /api/runs/:id/events`）

事件流不套 `ApiResponse` 信封。`Content-Type: text/event-stream`，`runtime = nodejs`。每条消息：

```
event: <type>
data: <JSON>
```

- `event` = `AgentEvent.type`（`model_step` / `tool_call_started` / …）或控制类 `snapshot` / `ping` / `done`。
- 业务事件 `data` 为 `AgentEventDTO`；
- 连接建立时先发一条 `event: snapshot`，`data` 为 `{ run: RunDTO; events: AgentEventDTO[] }`（断线重连后补齐已落事件）；
- 定期 `event: ping`（心跳保活）；
- run 终态后发 `event: done` 并关闭。

前端据 `event` 分发渲染；`seq` 用于去重与排序（与 DB 事实源一致）。

## 7. 前端状态管理与接口使用策略

> 详见 [ADR-0004](./adr/0004-frontend-state-management-and-realtime-sync.md)

前端状态来自两个数据源：

1. **SSE 事件流**（`/api/runs/:runId/events`）—— 实时推送执行过程事件
2. **DB 快照**（`/api/sessions/:sessionId`）—— 持久化的会话、消息、runs 数据

### 场景化接口调用

| 场景 | 调用顺序 | 说明 |
|------|---------|------|
| **发送新消息** | `POST /sessions/:id/runs` → 立刻建立 SSE `/runs/:runId/events` | 不等 POST 响应就开始监听 SSE |
| **刷新（run 进行中）** | `GET /sessions/:id` → 检测到 `running` → 重连 SSE | SSE 首条 `snapshot` 补齐历史 |
| **刷新（run 已完成）** | 仅 `GET /sessions/:id` | 无需 SSE |
| **SSE 连接失败** | 降级到轮询：每 5s `GET /sessions/:id` | React Query `refetchInterval` 条件化 |

### 关键实现要点

1. **主流程不 refetch**：SSE `done` 后**不再调用** `GET /sessions/:id`，SSE 已推送完整数据（含最终 assistant 消息），直接清除 `activeRunId`。
2. **DB First 原则**：首屏始终先 `GET /sessions/:id` 拿初始状态，SSE 作为增量更新。
3. **条件化轮询**：`useQuery` 的 `refetchInterval` 根据 `sseConnected` 动态切换（连接时 `false`，断开时 `5000`）。
4. **自动重连**：SSE 断开时重连 3 次，失败后才降级轮询。
5. **心跳检测**：30s 无 SSE 消息（包括 `ping`）触发重连。

### 错误处理

| 错误场景 | 前端行为 |
|---------|---------|
| `POST /runs` 返回 4xx/5xx | 显示错误提示，清除乐观渲染 |
| SSE 连接失败（3 次重试后） | 显示"实时连接失败，正在轮询更新" |
| `GET /sessions/:id` 返回 404 | 跳转到邀请码页或首页 |
| SSE 推送 `run_timeout` | 显示"任务超时" + 重试按钮 |
| SSE 推送 `run_cancelled` | 显示"已取消" |

## 8. 测试约定

- **服务端**（阶段 4 route tests）：断言响应 `code` / HTTP status / `data` 形状符合本规范；错误路径返回正确 `code`。
- **前端**（阶段 5/6.0）：mock 接口时按本规范造数据；渲染逻辑只依赖 DTO 字段，不依赖裸 DB 结构。
- 信封 helper（`ok`/`fail`）有独立单元测试，保证结构稳定。
- **状态管理测试**（阶段 6.0）：覆盖场景 S1-S4 与边缘情况 E1-E10（见 ADR-0004）。

# 后台审计日志方案

本文定义 `apps/api` 的后台日志层目标和落地顺序。审计日志用于回答三个问题：

- 谁在什么时间调用了哪个 API。
- 该调用影响了哪个 `workspaceId`、`threadId`、`runId`。
- SSE/ingest/agent loop 的每个关键 event 是否被产生、发送、完成或失败。

## 1. 原则

- 日志是结构化 JSON，不写自由文本流水账。
- 每条日志必须带 `requestId`、`timestamp`、`level`、`event`。
- 能拿到业务上下文时必须带 `userId`、`workspaceId`、`threadId`、`runId`。
- 不记录 secret、cookie、authorization header、run token、Better Auth token、完整密码、完整本机路径。
- API response 可以记录状态码、业务 `code`、耗时、响应体摘要；不能默认记录完整 response body。
- SSE 的事实事件按 event 粒度记录；token stream chunk 可以合并成批次摘要，避免一 token 一行。

## 2. 日志事件类型

### 2.1 HTTP API

每个请求至少两条：

```json
{ "event": "api.request", "requestId": "...", "method": "POST", "path": "/api/threads/:threadId/runs" }
{ "event": "api.response", "requestId": "...", "status": 200, "code": 0, "durationMs": 42 }
```

错误请求追加：

```json
{ "event": "api.error", "requestId": "...", "status": 500, "errorName": "Error", "message": "..." }
```

### 2.2 Run Lifecycle

Run 创建、状态转移、取消、sweep 收敛必须记录：

```json
{ "event": "run.created", "runId": "...", "workspaceId": "...", "threadId": "...", "userId": "..." }
{ "event": "run.transition", "runId": "...", "from": "running", "to": "completed", "applied": true }
```

### 2.3 Ingest Event

每次 sandbox 调 `/api/ingest/events` 记录一条摘要：

```json
{ "event": "ingest.event", "runId": "...", "seq": 7, "type": "agent_message", "accepted": true }
```

payload 只记录 schema 摘要，不默认记录全文。需要排障全文时使用单独 debug 开关，并且必须做敏感字段脱敏。

### 2.4 SSE

SSE 建连和关闭：

```json
{ "event": "sse.open", "requestId": "...", "runId": "...", "method": "POST", "cursor": "0" }
{ "event": "sse.close", "requestId": "...", "runId": "...", "status": "completed", "eventsSent": 12, "chunksSent": 4 }
```

每个事实 event 发送时记录：

```json
{ "event": "sse.event_sent", "requestId": "...", "runId": "...", "seq": 8, "type": "tool_call_completed" }
```

token stream 不按 token 打日志，按批次记录：

```json
{ "event": "sse.stream_batch_sent", "requestId": "...", "runId": "...", "count": 25, "fromCursor": "1700000000000-0", "toCursor": "1700000000100-4" }
```

## 3. 实现位置

- `apps/api/src/logging/logger.ts`：统一 logger，先输出 JSON 到 stdout。
- `apps/api/src/logging/http-middleware.ts`：Hono middleware，包住所有 `/api/*`。
- `apps/api/src/logging/redact.ts`：统一脱敏和 body 摘要。
- `apps/api/src/run/routes.ts`：SSE open/event/batch/close 日志。
- `apps/api/src/ingest/routes.ts`：ingest event/tool/file/artifact/source 日志。
- `apps/api/src/run/transition-run.ts`：状态转移日志。
- `apps/api/src/agent-loop/agent-loop.ts`：agent loop 阶段日志。
- `apps/api/src/sweep/*`：sweep 命中和处理结果日志。

## 4. 测试要求

- HTTP middleware test：请求成功、业务失败、异常路径都输出 request/response/error。
- Redaction test：cookie、authorization、password、token 字段不会出现在日志中。
- SSE integration test：POST SSE 至少记录 `sse.open`、`sse.event_sent`、`sse.close`。
- Stream chunk test：多个 chunk 输出 batch 摘要，不输出每个 token。
- Run transition test：状态转移成功和 no-op 都有审计日志。

## 5. 落地顺序

1. 先加 logger + HTTP middleware，所有 API 请求可见。
2. 再加 run/transition/ingest 日志，让后台状态变化可审计。
3. 再加 SSE event 粒度日志和 stream batch 摘要。
4. 最后把日志字段接入部署环境查询方式，并更新 run 排障手册。

P0 先写 stdout JSON，后续部署层决定接 Vercel log drain、OpenTelemetry collector 或其他日志后端。

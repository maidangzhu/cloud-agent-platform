# 前端状态管理测试计划

> 本文档列出阶段 6.0 前端状态管理重构需要覆盖的测试场景。  
> 相关决策：[ADR-0004](./adr/0004-frontend-state-management-and-realtime-sync.md)

## 1. 测试策略

### 测试层次

| 层次 | 范围 | 工具 |
|------|------|------|
| **单元测试** | `useSessionState` / `useRunSSE` hooks | Vitest + React Testing Library |
| **集成测试** | 完整页面组件 + mock API | Playwright Component Testing |
| **E2E 测试** | 真实浏览器 + 真实 API | Playwright E2E |

### 测试原则

1. **先单元后集成**：hooks 逻辑先用 Vitest 测试，页面交互再用 Playwright。
2. **mock 最小化**：只 mock 不可控的外部依赖（SSE、网络延迟），不 mock 业务逻辑。
3. **场景完整性**：每个场景覆盖"用户操作 → 接口调用 → 状态更新 → UI 渲染"全链路。

## 2. 主流程场景（S1-S4）

### S1: 发送新消息

**前置条件**：用户已在 `/chat/:sessionId` 页面，无活跃 run。

**操作步骤**：
1. 输入消息 "查找 TODO"
2. 点击发送按钮

**预期行为**：
- ✅ 立刻显示用户消息气泡（乐观渲染）
- ✅ 发送按钮变为"运行中"并禁用
- ✅ POST `/api/sessions/:id/runs` 成功返回 `runId`
- ✅ 立刻建立 SSE 连接到 `/api/runs/:runId/events`
- ✅ SSE 推送 `snapshot` → 初始化事件列表
- ✅ SSE 推送 `agent_started` → 显示"Agent 启动"
- ✅ SSE 推送 `tool_call_started` → 显示工具调用卡片
- ✅ SSE 推送 `model_step` → 逐步显示 AI 回复
- ✅ SSE 推送 `run_completed` → 标记完成
- ✅ SSE 推送 `done` → 关闭连接，清除 `activeRunId`
- ✅ **不触发** `GET /api/sessions/:id` 请求
- ✅ 发送按钮恢复可用

**断言**：
```typescript
expect(screen.getByText("查找 TODO")).toBeInTheDocument(); // 用户消息
expect(screen.getByText(/找到 3 个 TODO/)).toBeInTheDocument(); // AI 回复
expect(fetchMock).toHaveBeenCalledTimes(1); // 仅 POST /runs，无 GET session
expect(screen.getByRole("button", { name: "发送" })).not.toBeDisabled();
```

---

### S2: 刷新页面（run 进行中）

**前置条件**：有一个 run 正在执行（status = `running`）。

**操作步骤**：
1. 刷新浏览器页面

**预期行为**：
- ✅ 首次调用 `GET /api/sessions/:id` 拿到 DB 数据
- ✅ 检测到 `runs[0].status === "running"`
- ✅ 自动建立 SSE 连接到 `/api/runs/:runId/events`
- ✅ SSE 首条 `snapshot` 携带已落库的事件（seq 0-5）
- ✅ 前端无缝显示历史事件 + 后续增量事件
- ✅ 用户看不到"加载中"闪烁

**断言**：
```typescript
expect(fetchMock).toHaveBeenCalledWith("/api/sessions/xxx"); // 首屏拉 DB
expect(mockEventSource).toHaveBeenCalledWith("/api/runs/yyy/events"); // 重连 SSE
expect(screen.getByText(/Agent 启动/)).toBeInTheDocument(); // 历史事件已恢复
```

---

### S3: 刷新页面（run 已完成）

**前置条件**：session 内所有 run 均已完成（status = `completed`）。

**操作步骤**：
1. 刷新浏览器页面

**预期行为**：
- ✅ 调用 `GET /api/sessions/:id` 拿到 DB 数据
- ✅ 检测到无进行中的 run
- ✅ **不建立** SSE 连接
- ✅ 显示完整对话历史
- ✅ 发送按钮可用

**断言**：
```typescript
expect(fetchMock).toHaveBeenCalledWith("/api/sessions/xxx");
expect(mockEventSource).not.toHaveBeenCalled(); // 无 SSE 连接
expect(screen.getByRole("button", { name: "发送" })).not.toBeDisabled();
```

---

### S4: 打开历史 session

**前置条件**：用户从首页点击一个历史 session 链接。

**操作步骤**：
1. 访问 `/chat/:sessionId`

**预期行为**：
- ✅ 同 S3（完整历史，无 SSE）

---

## 3. 边缘情况（E1-E10）

### E1: SSE 连接失败

**模拟**：EventSource 构造函数抛错或立刻触发 `error`。

**预期行为**：
- ✅ 显示"实时连接失败"提示
- ✅ 自动降级到轮询：`refetchInterval = 5000`
- ✅ 每 5s 调用 `GET /api/sessions/:id`
- ✅ 连接状态指示器显示"🟡 轮询中"

**断言**：
```typescript
await waitFor(() => {
  expect(screen.getByText(/实时连接失败/)).toBeInTheDocument();
});
expect(fetchMock).toHaveBeenCalledTimes(2); // 初始 + 第一次轮询
```

---

### E2: SSE 中途断开

**模拟**：SSE 推送几条事件后触发 `error`。

**预期行为**：
- ✅ 自动重连（第 1 次，间隔 2s）
- ✅ 重连失败 → 第 2 次（间隔 5s）
- ✅ 重连失败 → 第 3 次（间隔 10s）
- ✅ 3 次失败后降级到轮询
- ✅ 连接状态指示器："🟢" → "🔴" → "🟡"

**断言**：
```typescript
expect(mockEventSource).toHaveBeenCalledTimes(4); // 初始 + 3 次重连
await waitFor(() => {
  expect(screen.getByText(/🟡 轮询中/)).toBeInTheDocument();
});
```

---

### E3: Run 后台完成但 SSE 未连

**模拟**：用户关闭标签页，run 在后台完成，稍后重新打开。

**预期行为**：
- ✅ `GET /api/sessions/:id` 拿到最新状态（status = `completed`）
- ✅ 直接显示完成的结果，无 SSE 连接

**断言**：
```typescript
expect(fetchMock).toHaveBeenCalledWith("/api/sessions/xxx");
expect(screen.getByText(/找到 3 个 TODO/)).toBeInTheDocument();
expect(mockEventSource).not.toHaveBeenCalled();
```

---

### E4: 多标签页同开

**模拟**：在两个标签页同时打开同一 session，在 Tab A 发送消息。

**预期行为**（可选实现）：
- ✅ Tab A 正常显示进度
- ✅ Tab B 通过 BroadcastChannel 收到通知
- ✅ Tab B 调用 `GET /api/sessions/:id` 刷新状态

**断言**：
```typescript
// Tab B
await waitFor(() => {
  expect(screen.getByText("查找 TODO")).toBeInTheDocument();
});
```

---

### E5: Run 超时

**模拟**：SSE 推送 `run_timeout` 事件。

**预期行为**：
- ✅ 显示"任务超时"提示
- ✅ 显示"重试"按钮
- ✅ 点击重试 → 重新 POST `/api/sessions/:id/runs`

**断言**：
```typescript
expect(screen.getByText(/任务超时/)).toBeInTheDocument();
expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
```

---

### E6: Run 被取消

**模拟**：SSE 推送 `run_cancelled` 事件。

**预期行为**：
- ✅ 显示"已取消"状态
- ✅ 发送按钮恢复可用

**断言**：
```typescript
expect(screen.getByText(/已取消/)).toBeInTheDocument();
expect(screen.getByRole("button", { name: "发送" })).not.toBeDisabled();
```

---

### E7: POST /runs 成功但 SSE 连不上

**模拟**：POST 返回 200，但 EventSource 立刻报错。

**预期行为**：
- ✅ 显示"任务已提交"
- ✅ 降级到轮询（每 5s）
- ✅ 最终从 DB 拿到结果

**断言**：
```typescript
expect(screen.getByText(/任务已提交/)).toBeInTheDocument();
await waitFor(() => {
  expect(fetchMock).toHaveBeenCalledWith("/api/sessions/xxx");
});
```

---

### E8: 快速连发多条消息

**模拟**：用户狂按 Enter 键。

**预期行为**：
- ✅ 第一条消息发送，按钮禁用
- ✅ 后续按键无效
- ✅ run 完成后按钮恢复，才能发第二条

**断言**：
```typescript
fireEvent.click(sendButton);
expect(sendButton).toBeDisabled();
fireEvent.click(sendButton); // 第二次点击
expect(fetchMock).toHaveBeenCalledTimes(1); // 仅发送一次
```

---

### E9: SSE snapshot 不全

**模拟**：`snapshot` 事件只返回部分事件（seq 0-3），后续增量推送 seq 4-8。

**预期行为**：
- ✅ 先显示 seq 0-3
- ✅ 增量追加 seq 4-8
- ✅ 最终按 seq 顺序完整显示

**断言**：
```typescript
expect(screen.getAllByTestId("event")).toHaveLength(9); // 0-8
const events = screen.getAllByTestId("event");
expect(events[0]).toHaveTextContent("run_created");
expect(events[8]).toHaveTextContent("run_completed");
```

---

### E10: 浏览器休眠后恢复

**模拟**：触发 `visibilitychange` 事件（`document.visibilityState = "hidden"` → `"visible"`）。

**预期行为**：
- ✅ 检测到页面可见 + SSE 已断开
- ✅ 自动重连 SSE

**断言**：
```typescript
fireEvent(document, new Event("visibilitychange"));
await waitFor(() => {
  expect(mockEventSource).toHaveBeenCalledTimes(2); // 初始 + 重连
});
```

---

## 4. 接口测试覆盖矩阵

| 场景 | 接口调用 | 预期状态 | 能否用接口测试覆盖？ |
|------|---------|---------|---------------------|
| **S1: 发送新消息** | POST `/runs` → SSE → 无 GET | ✅ | ✅ **可以**（mock SSE，验证无 GET） |
| **S2: 刷新（run 进行中）** | GET `/sessions` → SSE | ✅ | ✅ **可以**（mock SSE，验证重连） |
| **S3: 刷新（run 已完成）** | GET `/sessions` → 无 SSE | ✅ | ✅ **可以**（验证无 SSE 连接） |
| **S4: 打开历史 session** | 同 S3 | ✅ | ✅ **可以** |
| **E1: SSE 连接失败** | GET → 轮询 | ✅ | ✅ **可以**（mock SSE 失败，验证轮询） |
| **E2: SSE 中途断开** | 重连 3 次 → 轮询 | ✅ | ✅ **可以**（mock 断开，验证重连次数） |
| **E3: 后台完成** | GET → 拿到最新 | ✅ | ✅ **可以** |
| **E4: 多标签页** | BroadcastChannel | 可选 | ⚠️ **部分**（需真实浏览器多窗口，E2E 测试） |
| **E5: Run 超时** | SSE 推 `timeout` | ✅ | ✅ **可以**（mock SSE 事件） |
| **E6: Run 取消** | SSE 推 `cancelled` | ✅ | ✅ **可以** |
| **E7: POST 成功 SSE 失败** | 降级轮询 | ✅ | ✅ **可以** |
| **E8: 快速连发** | 仅发送一次 | ✅ | ✅ **可以**（验证请求次数） |
| **E9: snapshot 不全** | 增量追加 | ✅ | ✅ **可以**（mock snapshot） |
| **E10: 休眠恢复** | 重连 SSE | ✅ | ✅ **可以**（手动触发 visibilitychange） |

## 5. 接口测试实施方案

### 优先级

1. **P0（阶段 6.0.7）**：S1-S4 主流程
2. **P1（阶段 6.0.8）**：E1-E3, E5-E10（除 E4 外所有边缘情况）
3. **P2（可选）**：E4 多标签页（需 E2E）

### 测试文件组织

```
tests/
  integration/
    frontend-state.integration.test.ts  # S1-S4 + E1-E10
  e2e/
    multi-tab-sync.e2e.test.ts         # E4（可选）
```

### Mock 策略

```typescript
// 模拟 SSE
const mockEventSource = vi.fn();
global.EventSource = mockEventSource as any;

// 模拟 fetch
const fetchMock = vi.fn();
global.fetch = fetchMock as any;

// 场景 S1：成功流程
fetchMock.mockResolvedValueOnce({
  ok: true,
  json: async () => ({ code: 0, data: { run: { id: "run-1" } } }),
});

const es = new EventSource("/api/runs/run-1/events");
es.dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify({ run: {...}, events: [] }) }));
es.dispatchEvent(new MessageEvent("agent_started", { data: JSON.stringify({ seq: 1, type: "agent_started" }) }));
// ...
es.dispatchEvent(new MessageEvent("done", { data: "{}" }));
```

## 6. 成功标准

阶段 6.0 完成时，需满足：

- ✅ S1-S4 所有主流程场景测试通过
- ✅ E1-E3, E5-E10 所有边缘情况测试通过（E4 可选）
- ✅ 测试覆盖率：hooks > 90%，组件 > 80%
- ✅ 无 flaky 测试（连续跑 10 次全绿）
- ✅ 手动 E2E 验证：真实浏览器 + 真实 API + 模拟断网

## 7. 下一步

1. 实现 `useSessionState` + `useRunSSE` hooks
2. 编写 hooks 单元测试（S1-S4）
3. 编写边缘情况测试（E1-E10）
4. 集成到 CI（`pnpm test:integration`）
5. 手动 E2E 验证

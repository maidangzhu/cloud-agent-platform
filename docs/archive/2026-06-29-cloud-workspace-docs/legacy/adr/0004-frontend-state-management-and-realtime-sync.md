# ADR-0004：前端状态管理与实时同步策略

- 状态：已采纳
- 日期：2026-06-23
- 相关：[ADR-0003](./0003-event-storage-and-frontend-rendering.md)、[ADR-0002](./0002-multi-turn-session.md)、[`architecture.md`](../architecture.md)

## 背景

阶段 5 实现的多轮对话 UI 中，前端状态来自两个数据源：

1. **SSE 事件流**（`/api/runs/:runId/events`）—— 实时推送执行过程事件
2. **DB 快照**（`/api/sessions/:sessionId`）—— 持久化的会话、消息、runs 数据

初版实现采用"SSE 完成后 refetch DB"模式：

```typescript
// 现状：SSE done 后触发一次 GET session
const { done: sseDone } = useRunEvents(activeRunId);
useEffect(() => {
  if (sseDone) {
    refetch().then(() => {  // 👈 每次 SSE 结束都拉一次 DB
      setActiveRunId(null);
      setPendingTurn(null);
    });
  }
}, [sseDone, refetch]);
```

这个设计在功能上可行，但存在以下问题：

1. **用户体验割裂**：主流程中，用户看到的 SSE 实时数据（`model_step` 事件中的 AI 回复）在 SSE 结束后被 DB 数据"替换"，造成短暂闪烁或状态重置感。
2. **不必要的网络请求**：每次 run 完成都触发 GET session，即使 SSE 已经推送了完整数据。
3. **逻辑不清晰**：到底哪个是"真相来源"？SSE 还是 DB？何时用哪个？

用户指出：**主流程场景下，发送消息后的所有渲染都应该通过 SSE 推送，这样才有进度感**。只有刷新页面、打开历史会话等场景才需要从 DB 还原。

## 决策

**采用"DB First, SSE Enhancement"双源合并策略 + 场景化数据源切换。**

### 核心原则

1. **DB 是唯一事实来源**（Single Source of Truth）  
   所有持久化数据（session、messages、runs、events）最终以 DB 为准。

2. **SSE 是实时视图增强**（Live View Enhancement）  
   运行中的 run，前端通过 SSE 获取实时事件流，增强 DB 数据的展示。

3. **渐进式加载**（Progressive Loading）  
   先展示 DB 数据（即使过期），SSE 连上后增量更新。

4. **弹性降级**（Resilient Degradation）  
   SSE 连接失败/断开时，降级到轮询或手动刷新，不阻塞用户。

### 场景化数据源切换

| 场景 | 初始数据源 | SSE 连接 | 降级策略 |
|------|-----------|----------|---------|
| **S1: 发送新消息** | 乐观渲染 | 立刻连接 `runId` | SSE 失败 → 每 5s 轮询 session |
| **S2: 刷新（run 进行中）** | GET session（DB） | 检测到 `running` → 重连 SSE | 同上 |
| **S3: 刷新（run 已完成）** | GET session（DB） | 无需连接 | N/A |
| **S4: 打开历史 session** | GET session（DB） | 全部完成 → 无需连接 | N/A |

### 边缘情况处理

| 场景 | 策略 |
|------|------|
| **E1: SSE 连接失败** | 显示"实时连接失败"，降级到 5s 轮询 |
| **E2: SSE 中途断开** | 自动重连 3 次（间隔 2s/5s/10s），失败后降级轮询 |
| **E3: Run 后台完成但 SSE 未连** | 首屏 GET session 拿到最新状态 |
| **E4: 多标签页同开** | BroadcastChannel API 同步状态（可选） |
| **E5: Run 超时** | SSE 推 `run_timeout`，UI 显示"任务超时" + 重试按钮 |
| **E6: Run 被取消** | SSE 推 `run_cancelled`，UI 显示"已取消" |
| **E7: POST /runs 成功但 SSE 连不上** | 显示"任务已提交"，每 5s 轮询 session |
| **E8: 快速连发多条消息** | `activeRunId` 存在时禁用发送按钮 |
| **E9: SSE snapshot 不全** | snapshot 只用于初始化，后续靠增量事件追加 |
| **E10: 浏览器休眠后恢复** | `visibilitychange` 事件检测页面可见时重连 SSE |

## 理由

### 1. 用户体验更流畅

主流程（S1）中，用户看到的 AI 回复从 SSE `model_step` 事件逐字推送，完成后**不再切换到 DB 数据**，避免闪烁。DB 数据只在刷新/恢复场景（S2/S3/S4）作为初始状态。

### 2. 减少不必要的请求

SSE 已经推送了完整数据（events、toolCalls、最终 assistant 消息），不需要每次 `done` 都 refetch session。只有以下情况才拉 DB：
- 首屏加载（GET session）
- SSE 降级到轮询（每 5s）
- 用户手动刷新

### 3. 职责更清晰

- **DB**：持久化存储，任何时候都能查到最新状态（刷新、恢复、审计）
- **SSE**：实时推送，只在 run 进行中连接，完成后断开，不依赖 DB 同步

### 4. 架构更健壮

SSE 断线不影响功能，自动降级到轮询。用户始终能看到进度，只是从"实时"变成"每 5 秒更新一次"。

## 实施方案

### 分层架构

```
┌─────────────────────────────────────────┐
│     UI Layer (React Components)          │  
│  ChatPage, RunTurn, RunTimeline          │
└──────────────┬──────────────────────────┘
               │ useSessionState(sessionId)
┌──────────────▼──────────────────────────┐
│      State Management Layer              │
│  - 合并 DB + SSE 数据                    │
│  - 处理乐观更新                          │
│  - 管理 activeRunId                      │
│  - 降级策略（SSE → Poll → Error）        │
└──────┬───────────────┬──────────────────┘
       │               │
┌──────▼─────┐   ┌────▼─────────────────┐
│ DB Layer   │   │ SSE Layer            │
│ (React     │   │ - 自动重连           │
│  Query)    │   │ - 心跳检测           │
│            │   │ - 错误处理           │
└────────────┘   └──────────────────────┘
```

### 核心 Hook：`useSessionState`

```typescript
export function useSessionState(sessionId: string) {
  // 1. DB 数据（初始化 + 降级时轮询）
  const { data: dbSnapshot, refetch } = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => fetchSession(sessionId),
    refetchInterval: sseConnected ? false : 5000, // SSE 断了才轮询
  });

  // 2. SSE 连接（只连接 running 的 run）
  const activeRunId = findRunningRun(dbSnapshot?.runs);
  const { events, connected } = useRunSSE(activeRunId, {
    onDone: () => {
      // SSE 完成后不再 refetch，直接清除 activeRunId
      // DB 数据已经在后台写入，下次首屏加载会拿到
    },
    onError: () => {
      setSseConnected(false); // 降级到轮询
    },
  });

  // 3. 合并状态
  const mergedRuns = useMemo(() => {
    if (!activeRunId) return dbSnapshot?.runs || [];
    return dbSnapshot.runs.map(run =>
      run.id === activeRunId
        ? { ...run, liveEvents: events } // 增强实时数据
        : run
    );
  }, [dbSnapshot, activeRunId, events]);

  // 4. 乐观更新
  const [pendingMessage, setPendingMessage] = useState(null);

  return {
    runs: mergedRuns,
    messages: dbSnapshot?.messages || [],
    pendingMessage,
    activeRunId,
    sseConnected: connected,
    sendMessage: async (prompt) => {
      // 发送消息逻辑
    },
  };
}
```

### 改进的 `useRunSSE`

```typescript
export function useRunSSE(
  runId: string | null,
  opts: { onDone, onError }
) {
  const [state, setState] = useState({ events: [], connected: false });
  const retryCount = useRef(0);

  useEffect(() => {
    if (!runId) return;

    const es = new EventSource(`/api/runs/${runId}/events`);
    let heartbeatTimer: NodeJS.Timeout;

    // 心跳检测（30s 没消息就重连）
    const resetHeartbeat = () => {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        es.close();
        if (retryCount.current < 3) {
          retryCount.current++;
          // 触发重连（依赖 useEffect 重新执行）
        } else {
          opts.onError("SSE heartbeat timeout");
        }
      }, 30_000);
    };

    es.onopen = () => {
      setState(prev => ({ ...prev, connected: true }));
      retryCount.current = 0;
      resetHeartbeat();
    };

    es.addEventListener("snapshot", (e) => {
      const { events } = JSON.parse(e.data);
      setState({ events, connected: true });
      resetHeartbeat();
    });

    // 业务事件追加
    const BUSINESS_EVENTS = [
      "run_created", "workspace_provisioning", "workspace_ready",
      "workspace_resumed", "agent_started", "model_step",
      "tool_call_started", "tool_call_completed", "tool_call_failed",
      "artifact_created", "run_completed", "run_failed",
      "run_timeout", "cancel_requested", "run_cancelled",
    ];
    BUSINESS_EVENTS.forEach(type => {
      es.addEventListener(type, (e) => {
        const ev = JSON.parse(e.data);
        setState(prev => ({ ...prev, events: [...prev.events, ev] }));
        resetHeartbeat();
      });
    });

    es.addEventListener("done", () => {
      opts.onDone();
      es.close();
    });

    es.onerror = () => {
      setState(prev => ({ ...prev, connected: false }));
      clearTimeout(heartbeatTimer);
      opts.onError("SSE connection error");
    };

    // 浏览器休眠恢复
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && !state.connected) {
        es.close(); // 触发重连
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      es.close();
      clearTimeout(heartbeatTimer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [runId, retryCount.current]);

  return state;
}
```

### UI 状态指示器

```typescript
<div className="connection-status">
  {sseConnected && <span>🟢 实时连接</span>}
  {!sseConnected && polling && <span>🟡 轮询中（SSE 已断开）</span>}
  {!sseConnected && !polling && <span>🔴 离线</span>}
</div>
```

## 取舍

| 维度 | 双源合并方案（本 ADR） | SSE 完成后 refetch（现状） |
|------|---------------------|-------------------------|
| 用户体验 | ✅ 流畅，无闪烁 | ❌ SSE → DB 切换有闪烁 |
| 网络请求 | ✅ 只在必要时拉 DB | ❌ 每次 run 完成都 refetch |
| 实现复杂度 | 较高：需要合并 DB + SSE 数据 | 低：直接 refetch 覆盖 |
| 弹性 | ✅ SSE 断了降级到轮询 | ❌ SSE 断了没有降级 |
| 职责清晰度 | ✅ DB = 持久，SSE = 实时 | ❌ 不清楚哪个是真相 |

现状方案在 demo 场景够用，但在生产环境下（网络不稳定、长 run、多标签页）会暴露体验和健壮性问题。双源合并方案虽然实现复杂度更高，但对生产级平台更适配。

## 实施步骤

### 阶段 6.0：重构前端状态管理

1. ✅ 提取 `useSessionState` hook（合并 DB + SSE）
2. ✅ 改进 `useRunSSE`（心跳、重连、降级）
3. ✅ 添加轮询 fallback（`refetchInterval` 条件化）
4. ✅ 处理 E1-E10 边缘情况
5. ✅ UI 连接状态指示器
6. ✅ 测试场景：S1-S4 + E1-E10

### 阶段 6.1+：保持不变

snapshot/resume、Vercel 部署、README 等保持原计划。

## 结论

采用"DB First, SSE Enhancement"双源合并策略，主流程完全依赖 SSE 实时推送，只有刷新/恢复场景从 DB 加载。SSE 连接失败时自动降级到轮询，确保任何网络环境下用户都能看到进度。这是生产级实时 Web 应用的标准做法。

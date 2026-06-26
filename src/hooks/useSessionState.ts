// 前端状态管理核心 hook：合并 DB + SSE 数据
"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRunSSE } from "./useRunSSE";
import type { SessionDetailData, RunDTO, AgentEventDTO } from "@/lib/api-contract";

export interface UseSessionStateResult {
  // DB 数据
  session: SessionDetailData["session"] | null;
  messages: SessionDetailData["messages"];
  runs: RunDTO[];

  // 实时状态
  activeRunId: string | null;
  sseConnected: boolean;
  pendingMessage: { prompt: string; runId: string } | null;
  liveEvents: AgentEventDTO[]; // SSE 实时事件流

  // 操作
  sendMessage: (prompt: string) => Promise<void>;
  cancelRun: (runId: string) => Promise<void>;
  isCancelling: (runId: string) => boolean;
  isLoading: boolean;
  error: Error | null;
}

/**
 * 检测 runs 中是否有进行中的 run
 */
function findRunningRun(runs: RunDTO[], completedRunIds: Set<string>): string | null {
  const runningRun = runs.find(
    (r) =>
      !completedRunIds.has(r.id) &&
      (r.status === "created" ||
        r.status === "provisioning_workspace" ||
        r.status === "running")
  );
  console.log("[findRunningRun] Checking runs:", runs.map(r => ({ id: r.id, status: r.status })));
  console.log("[findRunningRun] Found running run:", runningRun?.id);
  return runningRun?.id || null;
}

export function useSessionState(sessionId: string): UseSessionStateResult {
  const [pendingMessage, setPendingMessage] = useState<{
    prompt: string;
    runId: string;
  } | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [completedRunIds, setCompletedRunIds] = useState<Set<string>>(() => new Set());
  const [eventsCache, setEventsCache] = useState<Record<string, AgentEventDTO[]>>({});
  // 正在点取消的 run（optimistic：API 调用尚未完成 / SSE 尚未推 cancelled 事件）
  const [cancellingRunIds, setCancellingRunIds] = useState<Set<string>>(() => new Set());

  // 1. DB 数据（初始化 + 降级时轮询）
  const {
    data: dbSnapshot,
    isLoading,
    error,
    refetch,
  } = useQuery<{ code: number; data: SessionDetailData }>({
    queryKey: ["session", sessionId],
    queryFn: async () => {
      console.log("[useSessionState] Fetching session data for:", sessionId);
      const res = await fetch(`/api/sessions/${sessionId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      console.log("[useSessionState] Session data received:", data);
      return data;
    },
    enabled: !!sessionId,
    refetchInterval: (query) => {
      const snapshot = query.state.data as { data: SessionDetailData } | undefined;
      const runningRunId = findRunningRun(snapshot?.data.runs || [], completedRunIds);
      console.log("[useSessionState] refetchInterval check - runningRunId:", runningRunId);
      return runningRunId ? 5000 : false;
    },
  });

  // 2. SSE 连接（只连接 running 的 run）
  const detectedRunningRunId = findRunningRun(dbSnapshot?.data.runs || [], completedRunIds);
  const runningRunId = activeRunId || detectedRunningRunId;
  console.log("[useSessionState] SSE connection check:", {
    activeRunId,
    detectedRunningRunId,
    runningRunId,
    dbRuns: dbSnapshot?.data.runs,
    completedRunIds: Array.from(completedRunIds),
  });

  const { events, connected } = useRunSSE(runningRunId, {
    onDone: (finalEvents) => {
      console.log("[useSessionState] SSE onDone triggered for runId:", runningRunId);
      // run 走到终态（completed/failed/cancelled/timeout），清掉 cancelling 标记
      if (runningRunId) {
        setCancellingRunIds((prev) => {
          if (!prev.has(runningRunId)) return prev;
          const next = new Set(prev);
          next.delete(runningRunId);
          return next;
        });
      }
      if (runningRunId && finalEvents.length > 0) {
        setEventsCache((prev) => ({ ...prev, [runningRunId]: finalEvents }));
        console.log(`[useSessionState] 缓存 runId=${runningRunId} 的 events:`, finalEvents.length);
      }
      setCompletedRunIds((prev) => new Set(prev).add(runningRunId!));
      setActiveRunId(null);
      setPendingMessage(null);
      // 立即 refetch DB，确保新完成的 run 出现在 runs 列表里
      refetch();
    },
    onError: (msg) => {
      console.warn("[useSessionState] SSE error:", msg);
      // 降级到轮询（refetchInterval 会自动生效）
    },
  });

  // 3. 合并状态：DB + SSE（保留已完成 run 的 liveEvents）
  const mergedRuns = (dbSnapshot?.data.runs || []).map((run) => {
    // 如果是当前活动的 run，使用实时 events
    if (run.id === runningRunId) {
      console.log(`[useSessionState] Run ${run.id} is active, using SSE events:`, events.length);
      return { ...run, liveEvents: events };
    }
    // 如果 run 已完成，优先使用缓存的 events，否则用 DB 的 events
    const cachedEvents = eventsCache[run.id];
    if (cachedEvents) {
      console.log(`[useSessionState] Run ${run.id} using cached events:`, cachedEvents.length);
      return { ...run, liveEvents: cachedEvents };
    }
    // 从 DB 加载的 events（如果接口返回了）
    if (run.events && run.events.length > 0) {
      console.log(`[useSessionState] Run ${run.id} using DB events:`, run.events.length, run.events.map(e => e.type));
      return { ...run, liveEvents: run.events };
    }
    console.log(`[useSessionState] Run ${run.id} has no events`);
    return run;
  });

  // 4. 发送消息
  const sendMessage = async (prompt: string) => {
    console.log("[useSessionState] sendMessage called with prompt:", prompt);
    console.log("[useSessionState] Current state:", {
      submitting,
      runningRunId,
      activeRunId,
    });

    if (!prompt.trim() || submitting || runningRunId) {
      console.log("[useSessionState] sendMessage blocked:", {
        emptyPrompt: !prompt.trim(),
        submitting,
        runningRunId,
      });
      return; // 阻止快速连发
    }

    const trimmedPrompt = prompt.trim();
    setSubmitting(true);

    // 乐观渲染
    const tempRunId = `pending-${Date.now()}`;
    setPendingMessage({ prompt: trimmedPrompt, runId: tempRunId });
    console.log("[useSessionState] Pending message set:", { prompt: trimmedPrompt, tempRunId });

    try {
      console.log("[useSessionState] Sending POST to /api/sessions/" + sessionId + "/runs");
      const res = await fetch(`/api/sessions/${sessionId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: trimmedPrompt }),
      });

      const result = await res.json();
      console.log("[useSessionState] POST response:", result);

      if (result.code === 0) {
        const realRunId = result.data.run.id;
        console.log("[useSessionState] Run created successfully, realRunId:", realRunId);
        setPendingMessage({ prompt: trimmedPrompt, runId: realRunId });
        setActiveRunId(realRunId);
      } else {
        // 发送失败，清除乐观渲染
        console.error("[useSessionState] Failed to send message:", result.message);
        setPendingMessage(null);
      }
    } catch (err) {
      console.error("[useSessionState] Failed to send message:", err);
      setPendingMessage(null);
    } finally {
      setSubmitting(false);
      console.log("[useSessionState] Submitting state reset");
    }
  };

  /**
   * 取消一个正在进行的 run。
   * - 乐观把 run 标为 "cancelling"（按钮立刻变 loading）
   * - 调 POST /api/runs/:id/cancel → DB 写 cancel_requested
   * - 后端 prepareNextTurn 在下一轮读 DB → agent.abort() → SSE 推 run_cancelled
   * - 失败时移除乐观标记 + 抛错给 UI 显示
   */
  const cancelRun = async (runId: string) => {
    if (!runId || cancellingRunIds.has(runId)) return;
    setCancellingRunIds((prev) => new Set(prev).add(runId));
    try {
      const res = await fetch(`/api/runs/${runId}/cancel`, { method: "POST" });
      const body = await res.json();
      if (res.ok && body.code === 0) {
        // 触发 refetch，让 derivedUiState 立刻反映 status=cancel_requested → "cancelling"
        refetch();
        return;
      }
      // 业务错：移除乐观标记，错误抛给 UI
      setCancellingRunIds((prev) => {
        const next = new Set(prev);
        next.delete(runId);
        return next;
      });
      throw new Error(body.message || `HTTP ${res.status}`);
    } catch (err) {
      setCancellingRunIds((prev) => {
        const next = new Set(prev);
        next.delete(runId);
        return next;
      });
      throw err;
    }
  };

  const isCancelling = (runId: string) => cancellingRunIds.has(runId);

  return {
    session: dbSnapshot?.data.session || null,
    messages: dbSnapshot?.data.messages || [],
    runs: mergedRuns,
    activeRunId: runningRunId,
    sseConnected: connected,
    pendingMessage,
    liveEvents: events, // 直接暴露 SSE 事件流
    sendMessage,
    cancelRun,
    isCancelling,
    isLoading,
    error: error as Error | null,
  };
}

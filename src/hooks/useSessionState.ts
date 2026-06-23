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

  // 1. DB 数据（初始化 + 降级时轮询）
  const {
    data: dbSnapshot,
    isLoading,
    error,
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
    onDone: () => {
      console.log("[useSessionState] SSE onDone triggered for runId:", runningRunId);
      // 缓存当前 run 的 events
      if (runningRunId) {
        setCompletedRunIds((prev) => new Set(prev).add(runningRunId));
        if (events.length > 0) {
          setEventsCache((prev) => ({ ...prev, [runningRunId]: events }));
          console.log(`[useSessionState] 缓存 runId=${runningRunId} 的 events:`, events.length);
        }
      }

      // SSE 完成后不 refetch，直接清除 activeRunId
      setActiveRunId(null);
      setPendingMessage(null);
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
      return { ...run, liveEvents: events };
    }
    // 如果 run 已完成，优先使用缓存的 events，否则用 DB 的 events
    const cachedEvents = eventsCache[run.id];
    if (cachedEvents) {
      return { ...run, liveEvents: cachedEvents };
    }
    // 从 DB 加载的 events（如果接口返回了）
    if (run.events && run.events.length > 0) {
      return { ...run, liveEvents: run.events };
    }
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

  return {
    session: dbSnapshot?.data.session || null,
    messages: dbSnapshot?.data.messages || [],
    runs: mergedRuns,
    activeRunId: runningRunId,
    sseConnected: connected,
    pendingMessage,
    liveEvents: events, // 直接暴露 SSE 事件流
    sendMessage,
    isLoading,
    error: error as Error | null,
  };
}

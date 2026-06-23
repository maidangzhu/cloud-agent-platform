// 前端状态管理核心 hook：合并 DB + SSE 数据
"use client";
import { useMemo, useState, useRef } from "react";
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
function findRunningRun(runs: RunDTO[]): string | null {
  const runningRun = runs.find(
    (r) =>
      r.status === "provisioning_workspace" ||
      r.status === "running"
  );
  return runningRun?.id || null;
}

export function useSessionState(sessionId: string): UseSessionStateResult {
  const [pendingMessage, setPendingMessage] = useState<{
    prompt: string;
    runId: string;
  } | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // 缓存已完成 run 的 events（key: runId, value: events）
  const eventsCache = useRef<Record<string, any[]>>({});

  // 1. DB 数据（初始化 + 降级时轮询）
  const {
    data: dbSnapshot,
    refetch,
    isLoading,
    error,
  } = useQuery<{ code: number; data: SessionDetailData }>({
    queryKey: ["session", sessionId],
    queryFn: async () => {
      const res = await fetch(`/api/sessions/${sessionId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: !!sessionId,
    refetchInterval: sseConnected ? false : 5000, // SSE 断了才轮询
  });

  // 2. SSE 连接（只连接 running 的 run）
  const detectedRunningRunId = findRunningRun(dbSnapshot?.data.runs || []);
  const targetRunId = activeRunId || detectedRunningRunId;

  const { events, connected } = useRunSSE(targetRunId, {
    onDone: () => {
      // 缓存当前 run 的 events
      if (targetRunId && events.length > 0) {
        eventsCache.current[targetRunId] = events;
        console.log(`[useSessionState] 缓存 runId=${targetRunId} 的 events:`, events.length);
      }

      // SSE 完成后不 refetch，直接清除 activeRunId
      setActiveRunId(null);
      setPendingMessage(null);
      setSseConnected(false);
    },
    onError: (msg) => {
      console.warn("SSE error:", msg);
      setSseConnected(false);
      // 降级到轮询（refetchInterval 会自动生效）
    },
  });

  // 同步 connected 状态
  if (connected !== sseConnected) {
    setSseConnected(connected);
  }

  // 3. 合并状态：DB + SSE（保留已完成 run 的 liveEvents）
  const mergedRuns = useMemo(() => {
    if (!dbSnapshot?.data.runs) return [];

    return dbSnapshot.data.runs.map((run) => {
      // 如果是当前活动的 run，使用实时 events
      if (run.id === targetRunId) {
        return { ...run, liveEvents: events };
      }
      // 如果 run 已完成，优先使用缓存的 events，否则用 DB 的 events
      const cachedEvents = eventsCache.current[run.id];
      if (cachedEvents) {
        return { ...run, liveEvents: cachedEvents };
      }
      // 从 DB 加载的 events（如果接口返回了）
      if (run.events && run.events.length > 0) {
        return { ...run, liveEvents: run.events };
      }
      return run;
    });
  }, [dbSnapshot?.data.runs, targetRunId, events]);

  // 4. 发送消息
  const sendMessage = async (prompt: string) => {
    if (!prompt.trim() || submitting || activeRunId) {
      return; // 阻止快速连发
    }

    const trimmedPrompt = prompt.trim();
    setSubmitting(true);

    // 乐观渲染
    const tempRunId = `pending-${Date.now()}`;
    setPendingMessage({ prompt: trimmedPrompt, runId: tempRunId });

    try {
      const res = await fetch(`/api/sessions/${sessionId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: trimmedPrompt }),
      });

      const result = await res.json();

      if (result.code === 0) {
        const realRunId = result.data.run.id;
        setPendingMessage({ prompt: trimmedPrompt, runId: realRunId });
        setActiveRunId(realRunId);
      } else {
        // 发送失败，清除乐观渲染
        setPendingMessage(null);
        console.error("Failed to send message:", result.message);
      }
    } catch (err) {
      console.error("Failed to send message:", err);
      setPendingMessage(null);
    } finally {
      setSubmitting(false);
    }
  };

  return {
    session: dbSnapshot?.data.session || null,
    messages: dbSnapshot?.data.messages || [],
    runs: mergedRuns,
    activeRunId,
    sseConnected,
    pendingMessage,
    liveEvents: events, // 直接暴露 SSE 事件流
    sendMessage,
    isLoading,
    error: error as Error | null,
  };
}

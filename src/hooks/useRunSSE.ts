// 改进的 SSE hook：心跳检测、自动重连、错误处理
"use client";
import { useEffect, useRef, useState } from "react";
import { fetchEventSource, EventStreamContentType } from "@microsoft/fetch-event-source";
import type { AgentEventDTO } from "@/lib/api-contract";

export interface UseRunSSEOptions {
  onDone: () => void;
  onError: (message: string) => void;
}

export interface UseRunSSEResult {
  events: AgentEventDTO[];
  connected: boolean;
}

export function useRunSSE(
  runId: string | null,
  opts: UseRunSSEOptions
): UseRunSSEResult {
  const [state, setState] = useState<UseRunSSEResult>({
    events: [],
    connected: false,
  });
  const retryCount = useRef(0);
  const onDoneRef = useRef(opts.onDone);
  const onErrorRef = useRef(opts.onError);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    onDoneRef.current = opts.onDone;
    onErrorRef.current = opts.onError;
  }, [opts.onDone, opts.onError]);

  useEffect(() => {
    console.log("[useRunSSE] Effect triggered, runId:", runId);

    if (!runId) {
      console.log("[useRunSSE] No runId, skipping SSE connection");
      return;
    }

    console.log("[useRunSSE] Starting SSE connection for runId:", runId);

    let heartbeatTimer: NodeJS.Timeout;
    let retryTimer: NodeJS.Timeout | undefined;
    const controller = new AbortController();

    // 心跳检测：10 分钟没消息才超时（后端会定期发 ping）
    const resetHeartbeat = () => {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        console.warn("[useRunSSE] Heartbeat timeout after 10 minutes, aborting connection");
        controller.abort();
        onErrorRef.current("SSE heartbeat timeout after 10 minutes");
        setState((prev) => ({ ...prev, connected: false }));
      }, 600_000); // 10 分钟 = 600,000 毫秒
    };

    const BUSINESS_EVENTS = [
      "run_created",
      "workspace_provisioning",
      "workspace_ready",
      "workspace_resumed",
      "agent_started",
      "model_step",
      "tool_call_started",
      "tool_call_completed",
      "tool_call_failed",
      "artifact_created",
      "run_completed",
      "run_failed",
      "run_timeout",
      "cancel_requested",
      "run_cancelled",
    ];

    const scheduleRetry = () => {
      setState((prev) => ({ ...prev, connected: false }));
      clearTimeout(heartbeatTimer);

      if (retryCount.current < 3) {
        const delays = [2000, 5000, 10000];
        const delay = delays[retryCount.current] || 10000;
        retryCount.current++;
        retryTimer = setTimeout(() => {
          setRetryNonce((prev) => prev + 1);
        }, delay);
      } else {
        onErrorRef.current("SSE connection error after 3 retries");
      }
    };

    fetchEventSource(`/api/runs/${runId}/events`, {
      method: "POST",
      headers: { accept: EventStreamContentType },
      signal: controller.signal,
      openWhenHidden: true,
      async onopen(response) {
        console.log("[useRunSSE] SSE connection opened, status:", response.status);
        if (!response.ok) {
          throw new Error(`SSE connection failed with status ${response.status}`);
        }
        if (!response.headers.get("content-type")?.includes(EventStreamContentType)) {
          throw new Error("SSE response is not text/event-stream");
        }

        console.log("[useRunSSE] SSE connection established successfully");
        setState((prev) => ({ ...prev, connected: true }));
        retryCount.current = 0;
        resetHeartbeat();
      },
      onmessage(message) {
        console.log("[useRunSSE] Received message:", message.event, message.data?.substring(0, 100));

        if (message.event === "snapshot") {
          const d = JSON.parse(message.data);
          console.log("[useRunSSE] Snapshot received, events count:", d.events?.length);
          setState({ events: d.events || [], connected: true });
          resetHeartbeat();
          return;
        }

        if (BUSINESS_EVENTS.includes(message.event)) {
          const ev: AgentEventDTO = JSON.parse(message.data);
          console.log(`[useRunSSE] Business event received:`, message.event, ev);
          setState((prev) => ({ ...prev, events: [...prev.events, ev] }));
          resetHeartbeat();
          return;
        }

        if (message.event === "ping") {
          console.log("[useRunSSE] Ping received");
          resetHeartbeat();
          return;
        }

        if (message.event === "done") {
          console.log("[useRunSSE] Done event received, closing connection");
          clearTimeout(heartbeatTimer);
          setState((prev) => ({ ...prev, connected: false }));
          onDoneRef.current();
          controller.abort();
        }
      },
      onclose() {
        console.log("[useRunSSE] Connection closed, aborted:", controller.signal.aborted);
        if (!controller.signal.aborted) {
          scheduleRetry();
        }
      },
      onerror(err) {
        console.error("[useRunSSE] Connection error:", err);
        if (!controller.signal.aborted) {
          scheduleRetry();
        }
        return null;
      },
    }).catch((err) => {
      console.error("[useRunSSE] FetchEventSource failed:", err);
      if (!controller.signal.aborted) {
        scheduleRetry();
      }
    });

    return () => {
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
      clearTimeout(heartbeatTimer);
    };
  }, [runId, retryNonce]);

  if (!runId) {
    return { events: [], connected: false };
  }

  return state;
}

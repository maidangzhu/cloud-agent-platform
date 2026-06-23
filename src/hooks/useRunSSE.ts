// 改进的 SSE hook：心跳检测、自动重连、错误处理
"use client";
import { useEffect, useRef, useState } from "react";
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
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!runId) {
      setState({ events: [], connected: false });
      return;
    }

    // 清理旧连接
    esRef.current?.close();

    let heartbeatTimer: NodeJS.Timeout;
    let es: EventSource;

    try {
      es = new EventSource(`/api/runs/${runId}/events`);
      esRef.current = es;
    } catch (err) {
      opts.onError(`SSE connection failed: ${err}`);
      return;
    }

    // 心跳检测：10 分钟没消息才超时（后端会定期发 ping）
    const resetHeartbeat = () => {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        console.warn("[useRunSSE] Heartbeat timeout after 10 minutes, closing connection");
        es.close();
        opts.onError("SSE heartbeat timeout after 10 minutes");
        setState((prev) => ({ ...prev, connected: false }));
      }, 600_000); // 10 分钟 = 600,000 毫秒
    };

    // onopen 处理
    const handleOpen = () => {
      setState((prev) => ({ ...prev, connected: true }));
      retryCount.current = 0; // 连接成功，重置重连计数
      resetHeartbeat();
    };

    // 直接赋值而不是通过 setter（兼容 mock）
    if ('onopen' in es) {
      es.onopen = handleOpen;
    }

    // snapshot 事件：初始化事件列表
    es.addEventListener("snapshot", (e) => {
      const d = JSON.parse(e.data);
      setState({ events: d.events || [], connected: true });
      resetHeartbeat();
    });

    // 业务事件：增量追加
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

    BUSINESS_EVENTS.forEach((type) => {
      es.addEventListener(type, (e) => {
        const ev: AgentEventDTO = JSON.parse(e.data);
        console.log(`[useRunSSE] 收到事件:`, type, ev);
        setState((prev) => ({ ...prev, events: [...prev.events, ev] }));
        resetHeartbeat();
      });
    });

    // ping 心跳
    es.addEventListener("ping", () => {
      resetHeartbeat();
    });

    // done 事件：完成
    es.addEventListener("done", () => {
      clearTimeout(heartbeatTimer);
      setState((prev) => ({ ...prev, connected: false }));
      opts.onDone();
      es.close();
    });

    // 错误处理
    es.onerror = () => {
      setState((prev) => ({ ...prev, connected: false }));
      clearTimeout(heartbeatTimer);

      // 重连逻辑
      if (retryCount.current < 3) {
        const delays = [2000, 5000, 10000];
        const delay = delays[retryCount.current] || 10000;
        retryCount.current++;

        setTimeout(() => {
          // 触发 useEffect 重新执行
          setState((prev) => ({ ...prev }));
        }, delay);
      } else {
        opts.onError("SSE connection error after 3 retries");
      }

      es.close();
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
      esRef.current = null;
    };
  }, [runId, retryCount.current]); // retryCount 变化时重连

  return state;
}

// SSE hook：订阅 /api/runs/:runId/events，将事件流转为结构化状态。
"use client";
import { useEffect, useRef, useState } from "react";
import type { AgentEventDTO, RunDTO } from "@/lib/api-contract";

export interface RunEventState {
  run: RunDTO | null;
  events: AgentEventDTO[];
  done: boolean;
}

export function useRunEvents(runId: string | null): RunEventState {
  const [state, setState] = useState<RunEventState>({ run: null, events: [], done: false });
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!runId) return;
    esRef.current?.close();

    const es = new EventSource(`/api/runs/${runId}/events`);
    esRef.current = es;

    es.addEventListener("snapshot", (e) => {
      const d = JSON.parse(e.data);
      setState({ run: d.run, events: d.events, done: false });
    });

    // 业务事件直接追加
    const BUSINESS_EVENTS = [
      "run_created", "workspace_provisioning", "workspace_ready", "workspace_resumed",
      "agent_started", "model_step", "tool_call_started", "tool_call_completed",
      "tool_call_failed", "artifact_created", "run_completed", "run_failed",
      "run_timeout", "cancel_requested", "run_cancelled",
    ];
    BUSINESS_EVENTS.forEach(type => {
      es.addEventListener(type, (e) => {
        const ev: AgentEventDTO = JSON.parse(e.data);
        setState(prev => ({ ...prev, events: [...prev.events, ev] }));
      });
    });

    es.addEventListener("done", () => {
      setState(prev => ({ ...prev, done: true }));
      es.close();
    });

    es.onerror = () => es.close();
    return () => { es.close(); esRef.current = null; };
  }, [runId]);

  return state;
}

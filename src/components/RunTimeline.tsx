// RunTimeline — 一次 Run 的执行过程（工具调用 + 模型步骤）
"use client";
import { useState } from "react";
import type { AgentEventDTO } from "@/lib/api-contract";
import { ToolCallCard } from "./ToolCallCard";

export function RunTimeline({
  events,
  isRunning,
}: {
  events: AgentEventDTO[];
  isRunning: boolean;
}) {
  const [open, setOpen] = useState(false);

  const toolStarts = events.filter(e => e.type === "tool_call_started");
  const toolCount = toolStarts.length;
  if (toolCount === 0 && !isRunning) return null;

  // 配对工具调用（started → completed/failed）
  const toolPairs: Array<{ start: AgentEventDTO; end?: AgentEventDTO }> = toolStarts.map(s => {
    const end = events.find(
      e =>
        (e.type === "tool_call_completed" || e.type === "tool_call_failed") &&
        e.seq > s.seq,
    );
    return { start: s, end };
  });

  const modelSteps = events.filter(e => e.type === "model_step");

  return (
    <div className="my-2">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        <span className={`inline-block w-2 h-2 rounded-full ${isRunning ? "bg-amber-400 animate-pulse" : "bg-zinc-600"}`} />
        <span>
          {isRunning ? "运行中…" : `${toolCount} 次工具调用`}
        </span>
        {toolCount > 0 && <span>{open ? "▲" : "▼"}</span>}
      </button>

      {open && (
        <div className="mt-2 space-y-2 pl-4 border-l border-zinc-800">
          {toolPairs.map(({ start, end }) => (
            <ToolCallCard key={start.seq} startEvent={start} endEvent={end} />
          ))}
          {modelSteps.map(e => (
            <div key={e.seq} className="text-sm text-zinc-400 italic py-1">
              {e.content}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// RunTimeline — 一次 Run 的执行过程（平铺显示所有事件）
"use client";
import type { AgentEventDTO } from "@/lib/api-contract";
import { ToolCallCard } from "./ToolCallCard";

export function RunTimeline({
  events,
  isRunning,
}: {
  events: AgentEventDTO[];
  isRunning: boolean;
}) {
  if (events.length === 0 && !isRunning) return null;

  console.log("[RunTimeline] All events:", events.map(e => ({ seq: e.seq, type: e.type })));

  // 配对工具调用（started → completed/failed）
  const toolStarts = events.filter((e) => e.type === "tool_call_started");
  const toolPairs: Array<{ start: AgentEventDTO; end?: AgentEventDTO }> = toolStarts.map((s) => {
    const end = events.find(
      (e) =>
        (e.type === "tool_call_completed" || e.type === "tool_call_failed") && e.seq > s.seq
    );
    return { start: s, end };
  });

  console.log("[RunTimeline] Tool pairs:", toolPairs.map(p => ({
    start: p.start.seq,
    end: p.end?.seq,
    endType: p.end?.type
  })));

  return (
    <div className="space-y-3 my-3">
      {/* 平铺显示所有事件 */}
      {events.map((event) => {
        // 工具调用
        if (event.type === "tool_call_started") {
          const pair = toolPairs.find((p) => p.start.seq === event.seq);
          return <ToolCallCard key={event.seq} startEvent={event} endEvent={pair?.end} />;
        }

        // model_step（AI 回复）
        if (event.type === "model_step") {
          return (
            <div
              key={event.seq}
              className="rounded-2xl rounded-bl-sm bg-zinc-900 border border-zinc-800 px-4 py-2.5 text-sm text-zinc-100 whitespace-pre-wrap"
            >
              {event.content}
            </div>
          );
        }

        // 状态事件（workspace_provisioning、agent_started 等）
        if (
          event.type === "workspace_provisioning" ||
          event.type === "workspace_ready" ||
          event.type === "agent_started" ||
          event.type === "run_failed" ||
          event.type === "run_completed"
        ) {
          const statusLabels: Record<string, string> = {
            workspace_provisioning: "🔧 正在准备工作环境…",
            workspace_ready: "✅ 工作环境就绪",
            agent_started: "🤖 Agent 开始工作",
            run_completed: "✅ 运行完成",
            run_failed: "❌ 运行失败",
          };

          const isError = event.type === "run_failed";

          return (
            <div key={event.seq} className={isError ? "text-sm text-red-400" : "text-xs text-zinc-500 italic"}>
              <div>{statusLabels[event.type]}</div>
              {isError && event.content && (
                <div className="mt-2 p-3 bg-red-950/30 border border-red-900/50 rounded text-xs font-mono whitespace-pre-wrap">
                  {event.content}
                </div>
              )}
            </div>
          );
        }

        // 其他事件跳过渲染（run_created、tool_call_completed 已在 ToolCallCard 中处理）
        return null;
      })}

      {/* 运行中指示器 */}
      {isRunning && (
        <div className="flex gap-1 pl-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce"
              style={{ animationDelay: `${i * 0.15}s` }}
              aria-hidden="true"
            />
          ))}
        </div>
      )}
    </div>
  );
}

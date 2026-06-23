// ToolCallCard — 工具调用折叠卡片
"use client";
import { useState } from "react";
import type { AgentEventDTO } from "@/lib/api-contract";
import { Button } from "./ui/button";

const TOOL_ICONS: Record<string, string> = {
  read_file: "📄",
  write_file: "✏️",
  list_files: "📁",
  search_text: "🔍",
  run_command: "⚡",
};

export function ToolCallCard({
  startEvent,
  endEvent,
}: {
  startEvent: AgentEventDTO;
  endEvent?: AgentEventDTO;
}) {
  const [open, setOpen] = useState(false);
  const tool = startEvent.title ?? "tool";
  const icon = TOOL_ICONS[tool] ?? "🔧";
  const pending = !endEvent;
  const failed = endEvent?.type === "tool_call_failed";

  const args = startEvent.payload?.args;
  const result = endEvent?.payload?.result;
  const errMsg = endEvent?.payload?.error;

  const statusColor = pending ? "text-zinc-400" : failed ? "text-red-400" : "text-emerald-400";

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 text-sm overflow-hidden">
      <Button
        variant="ghost"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`工具 ${tool}${pending ? "运行中" : failed ? "失败" : "完成"}${open ? "，已展开" : "，点击展开详情"}`}
        className="w-full justify-start h-auto px-3 py-2 hover:bg-zinc-800 focus-visible:ring-offset-0"
      >
        <span aria-hidden="true">{icon}</span>
        <span className="font-mono text-zinc-200">{tool}</span>
        <span className={`ml-auto text-xs ${statusColor}`}>
          {pending ? "running…" : failed ? "failed" : "done"}
        </span>
        <span className="text-zinc-500 ml-2" aria-hidden="true">
          {open ? "▲" : "▼"}
        </span>
      </Button>
      {open && (
        <div className="border-t border-zinc-800 px-3 py-2 space-y-2">
          {args !== undefined && (
            <div>
              <p className="text-xs text-zinc-500 mb-1">args</p>
              <pre className="text-xs text-zinc-300 whitespace-pre-wrap break-all">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {result !== undefined && (
            <div>
              <p className="text-xs text-zinc-500 mb-1">result</p>
              <pre className="text-xs text-zinc-300 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                {typeof result === "string"
                  ? result
                  : (result as any)?.content?.[0]?.text ?? JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
          {errMsg && (
            <p className="text-xs text-red-400" role="alert">
              {errMsg}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useRunEvents } from "@/hooks/useRunEvents";
import { RunTimeline } from "@/components/RunTimeline";
import type { SessionDetailData, RunDTO, AgentEventDTO } from "@/lib/api-contract";

// ── 每条"对话轮"的渲染单元 ──────────────────────────────────────────────────
// 一个"轮"= 一条 user 消息 + 对应 Run 的执行过程（SSE 事件流）+ assistant 最终回复
function RunTurn({
  userContent,
  runId,
  assistantContent,
  isActiveRun,
}: {
  userContent: string;
  runId: string;
  assistantContent?: string;
  isActiveRun: boolean;
}) {
  const { events, done } = useRunEvents(isActiveRun ? runId : null);
  const isRunning = isActiveRun && !done;

  // 从事件流里提取 model_step（最终回复候选）
  const modelSteps = events.filter(e => e.type === "model_step");
  const lastStep = modelSteps.at(-1)?.content ?? "";

  // 优先用 DB 里的 assistant 消息（run 完成后从 session 刷新），其次用实时事件
  const reply = assistantContent || (done ? lastStep : lastStep);

  return (
    <div className="space-y-3">
      {/* User */}
      <div className="flex justify-end">
        <div className="max-w-[70%] rounded-2xl rounded-br-sm bg-zinc-700 px-4 py-2.5 text-sm text-white">
          {userContent}
        </div>
      </div>

      {/* 执行过程 */}
      <RunTimeline events={events} isRunning={isRunning} />

      {/* Assistant reply */}
      {reply && (
        <div className="flex justify-start">
          <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-zinc-900 border border-zinc-800 px-4 py-2.5 text-sm text-zinc-100 whitespace-pre-wrap">
            {reply}
          </div>
        </div>
      )}
      {isRunning && !reply && (
        <div className="flex gap-1 pl-1">
          {[0, 1, 2].map(i => (
            <span key={i} className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── 主页面 ──────────────────────────────────────────────────────────────────
export default function ChatPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const router = useRouter();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    params.then(p => setSessionId(p.sessionId));
  }, [params]);

  const { data, refetch } = useQuery<{ code: number; data: SessionDetailData }>({
    queryKey: ["session", sessionId],
    queryFn: () => fetch(`/api/sessions/${sessionId}`).then(r => r.json()),
    enabled: !!sessionId,
    refetchInterval: activeRunId ? 2_000 : false,
  });

  // 自动滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [data?.data.messages.length, activeRunId]);

  // SSE done → 刷新 session（拿 assistant 消息）
  const { done: sseDone } = useRunEvents(activeRunId);
  useEffect(() => {
    if (sseDone) {
      refetch().then(() => setActiveRunId(null));
    }
  }, [sseDone, refetch]);

  if (!sessionId) return null;

  const session = data?.data;

  // 把 messages 和 runs 按 run 配对
  const runs: RunDTO[] = session?.runs ?? [];
  const msgs = session?.messages ?? [];

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || submitting) return;
    const prompt = input.trim();
    setInput(""); setSubmitting(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/runs`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const r = await res.json();
      if (r.code === 0) {
        setActiveRunId(r.data.run.id);
        refetch();
      }
    } finally {
      setSubmitting(false);
    }
  }

  function newSession() {
    localStorage.removeItem("sessionId");
    router.push("/invite");
  }

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-white">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <span className="text-sm font-medium text-zinc-300">Cloud Agent Platform</span>
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500 font-mono">{sessionId?.slice(0, 8)}…</span>
          <button onClick={newSession} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
            新会话
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-3xl space-y-8">
          {runs.length === 0 && (
            <div className="text-center text-zinc-500 text-sm pt-20">
              <p className="text-4xl mb-4">🤖</p>
              <p>输入任务，让 Agent 开始工作</p>
            </div>
          )}

          {runs.map((run) => {
            const userMsg = msgs.find(m => m.role === "user" && m.runId === run.id);
            const assistantMsg = msgs.find(m => m.role === "assistant" && m.runId === run.id);
            const isActive = run.id === activeRunId;
            return (
              <RunTurn
                key={run.id}
                runId={run.id}
                userContent={userMsg?.content ?? run.userPrompt}
                assistantContent={assistantMsg?.content}
                isActiveRun={isActive}
              />
            );
          })}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-zinc-800 px-4 py-4">
        <form onSubmit={send} className="mx-auto max-w-3xl flex gap-3">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(e as any); } }}
            placeholder="输入任务…（Shift+Enter 换行）"
            rows={1}
            disabled={submitting || !!activeRunId}
            className="flex-1 resize-none rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-sm text-white placeholder:text-zinc-500 outline-none focus:border-zinc-500 disabled:opacity-40 transition-colors"
          />
          <button
            type="submit"
            disabled={submitting || !!activeRunId || !input.trim()}
            className="rounded-xl bg-white px-5 py-2.5 text-sm font-medium text-zinc-900 disabled:opacity-40 hover:bg-zinc-100 transition-colors"
          >
            {submitting || activeRunId ? "运行中" : "发送"}
          </button>
        </form>
      </div>
    </div>
  );
}

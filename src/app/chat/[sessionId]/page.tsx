"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useRunEvents } from "@/hooks/useRunEvents";
import { RunTimeline } from "@/components/RunTimeline";
import type { SessionDetailData, RunDTO } from "@/lib/api-contract";

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
  const lastStep = events.filter(e => e.type === "model_step").at(-1)?.content ?? "";
  const reply = assistantContent || lastStep;

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <div className="max-w-[70%] rounded-2xl rounded-br-sm bg-zinc-700 px-4 py-2.5 text-sm text-white">
          {userContent}
        </div>
      </div>
      <RunTimeline events={events} isRunning={isRunning} />
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
            <span key={i} className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-bounce"
              style={{ animationDelay: `${i * 0.15}s` }} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ChatPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const router = useRouter();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  // 乐观渲染：按 Enter 立刻显示，不等 refetch
  const [pendingTurn, setPendingTurn] = useState<{ prompt: string; runId: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { params.then(p => setSessionId(p.sessionId)); }, [params]);

  const { data, refetch } = useQuery<{ code: number; data: SessionDetailData }>({
    queryKey: ["session", sessionId],
    queryFn: () => fetch(`/api/sessions/${sessionId}`).then(r => r.json()),
    enabled: !!sessionId,
    refetchInterval: false, // 不轮询，只在 SSE done 时手动 refetch 一次
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [data?.data.runs.length, pendingTurn]);

  // SSE done → 刷新 session 一次，拿 assistant 消息，清掉乐观轮
  const { done: sseDone } = useRunEvents(activeRunId);
  useEffect(() => {
    if (sseDone) {
      refetch().then(() => {
        setActiveRunId(null);
        setPendingTurn(null);
      });
    }
  }, [sseDone, refetch]);

  if (!sessionId) return null;

  const runs: RunDTO[] = data?.data.runs ?? [];
  const msgs = data?.data.messages ?? [];

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || submitting || activeRunId) return;
    const prompt = input.trim();
    setInput("");
    // 立刻显示用户消息（乐观渲染）
    setPendingTurn({ prompt, runId: `pending-${Date.now()}` });
    setSubmitting(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/runs`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const r = await res.json();
      if (r.code === 0) {
        setPendingTurn({ prompt, runId: r.data.run.id });
        setActiveRunId(r.data.run.id);
      } else {
        setPendingTurn(null);
      }
    } catch {
      setPendingTurn(null);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-white">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <span className="text-sm font-medium text-zinc-300">Cloud Agent Platform</span>
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500 font-mono">{sessionId?.slice(0, 8)}…</span>
          <button onClick={() => { localStorage.removeItem("sessionId"); router.push("/invite"); }}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
            新会话
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-3xl space-y-8">
          {runs.length === 0 && !pendingTurn && (
            <div className="text-center text-zinc-500 text-sm pt-20">
              <p className="text-4xl mb-4">🤖</p>
              <p>输入任务，让 Agent 开始工作</p>
            </div>
          )}

          {/* 已完成的轮次（来自 DB） */}
          {runs
            .filter(run => run.id !== pendingTurn?.runId)
            .map(run => (
              <RunTurn
                key={run.id}
                runId={run.id}
                userContent={msgs.find(m => m.role === "user" && m.runId === run.id)?.content ?? run.userPrompt}
                assistantContent={msgs.find(m => m.role === "assistant" && m.runId === run.id)?.content}
                isActiveRun={false}
              />
            ))}

          {/* 乐观渲染的当前轮次 */}
          {pendingTurn && (
            <RunTurn
              key={pendingTurn.runId}
              runId={pendingTurn.runId}
              userContent={pendingTurn.prompt}
              assistantContent={undefined}
              isActiveRun={activeRunId === pendingTurn.runId}
            />
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      <div className="border-t border-zinc-800 px-4 py-4">
        <form onSubmit={send} className="mx-auto max-w-3xl flex gap-3">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(e as any); }
            }}
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

"use client";
import { useEffect, useState } from "react";
import { useSessionState } from "@/hooks/useSessionState";
import { RunTimeline } from "@/components/RunTimeline";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Sidebar } from "@/components/Sidebar";
import type { AgentEventDTO } from "@/lib/api-contract";

function RunTurn({
  userContent,
  runId,
  assistantContent,
  liveEvents,
  isActiveRun,
}: {
  userContent: string;
  runId: string;
  assistantContent?: string;
  liveEvents?: AgentEventDTO[];
  isActiveRun: boolean;
}) {
  const isRunning = isActiveRun;
  const events = liveEvents || [];

  console.log(`[RunTurn] runId=${runId}, isActiveRun=${isActiveRun}, events 数量=${events.length}`);
  if (events.length > 0) {
    console.log(`[RunTurn] events 类型:`, events.map(e => e.type));
  }

  return (
    <div className="space-y-3 mb-8">
      {/* 用户消息 */}
      <div className="flex justify-end">
        <div className="max-w-[70%] rounded-2xl rounded-br-sm bg-zinc-700 px-4 py-2.5 text-sm text-white whitespace-pre-wrap">
          {userContent}
        </div>
      </div>

      {/* 事件流：平铺显示工具调用、model_step、状态等 */}
      <RunTimeline events={events} isRunning={isRunning} />

      {/* 如果 run 已完成且有 DB 中的 assistant 消息，显示它（兜底） */}
      {!isRunning && assistantContent && events.length === 0 && (
        <div className="flex justify-start">
          <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-zinc-900 border border-zinc-800 px-4 py-2.5 text-sm text-zinc-100 whitespace-pre-wrap">
            {assistantContent}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ChatPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");

  useEffect(() => {
    params.then((p) => setSessionId(p.sessionId));
  }, [params]);

  // 使用新的 useSessionState hook
  const {
    session,
    messages,
    runs,
    activeRunId,
    sseConnected,
    pendingMessage,
    liveEvents,
    sendMessage,
    isLoading,
  } = useSessionState(sessionId || "");

  // 调试：打印 liveEvents 和 activeRunId
  useEffect(() => {
    console.log(`[ChatPage] liveEvents 数量:`, liveEvents.length);
    console.log(`[ChatPage] activeRunId:`, activeRunId);
    console.log(`[ChatPage] pendingMessage:`, pendingMessage);
    if (liveEvents.length > 0) {
      console.log(`[ChatPage] liveEvents 详情:`, liveEvents);
    }
  }, [liveEvents, activeRunId, pendingMessage]);

  if (!sessionId) return null;

  // 骨架屏：数据加载中
  if (isLoading) {
    return (
      <div className="flex h-screen bg-zinc-950 text-white">
        <Sidebar />
        <div className="flex-1 flex flex-col">
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 w-24" />
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-6">
            <div className="mx-auto max-w-3xl space-y-8">
              {/* 骨架屏：对话轮次 */}
              {[1, 2].map((i) => (
                <div key={i} className="space-y-3">
                  {/* 用户消息 */}
                  <div className="flex justify-end">
                    <Skeleton className="h-10 w-64 rounded-2xl" />
                  </div>
                  {/* 工具调用 */}
                  <div className="space-y-2">
                    <Skeleton className="h-8 w-32" />
                    <Skeleton className="h-20 w-full rounded-lg" />
                  </div>
                  {/* AI 回复 */}
                  <div className="flex justify-start">
                    <Skeleton className="h-32 w-full max-w-[80%] rounded-2xl" />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-zinc-800 px-4 py-4">
            <div className="mx-auto max-w-3xl">
              <Skeleton className="h-44 w-full rounded-lg" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || activeRunId) return;
    const prompt = input.trim();
    setInput("");
    await sendMessage(prompt);
  }

  return (
    <div className="flex h-screen bg-zinc-950 text-white">
      <Sidebar />
      <div className="flex-1 flex flex-col">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <span className="text-sm font-medium text-zinc-300">{session?.title || "Chat"}</span>
          <div className="flex items-center gap-3">
            {/* 连接状态指示器 */}
            {activeRunId && (
              <div className="flex items-center gap-1.5 text-xs" role="status" aria-live="polite">
                {sseConnected ? (
                  <>
                    <span className="w-2 h-2 rounded-full bg-green-500" aria-hidden="true"></span>
                    <span className="text-zinc-400">实时连接</span>
                  </>
                ) : (
                  <>
                    <span className="w-2 h-2 rounded-full bg-yellow-500" aria-hidden="true"></span>
                    <span className="text-zinc-400">轮询中</span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-3xl flex flex-col-reverse">
          {/* 空状态提示（最底部） */}
          {runs.length === 0 && !pendingMessage && (
            <div className="text-center text-zinc-500 text-sm pb-20">
              <p className="text-4xl mb-4" aria-hidden="true">
                🤖
              </p>
              <p>输入任务，让 Agent 开始工作</p>
            </div>
          )}

          {/* 乐观渲染的当前轮次（最新，显示在最下面） */}
          {pendingMessage && (
            <RunTurn
              key={pendingMessage.runId}
              runId={pendingMessage.runId}
              userContent={pendingMessage.prompt}
              assistantContent={undefined}
              liveEvents={
                // 从 mergedRuns 中找到对应的 run，取其 liveEvents
                runs.find((r) => r.id === pendingMessage.runId)?.liveEvents || liveEvents
              }
              isActiveRun={activeRunId === pendingMessage.runId}
            />
          )}

          {/* 已完成的轮次（来自 DB，倒序渲染） */}
          {runs
            .filter((run) => run.id !== pendingMessage?.runId)
            .slice()
            .reverse() // 倒序：最新的在前面（视觉上在下面）
            .map((run) => {
              const userMsg = messages.find((m) => m.role === "user" && m.runId === run.id);
              const assistantMsg = messages.find(
                (m) => m.role === "assistant" && m.runId === run.id
              );

              return (
                <RunTurn
                  key={run.id}
                  runId={run.id}
                  userContent={userMsg?.content ?? run.userPrompt}
                  assistantContent={assistantMsg?.content}
                  liveEvents={run.liveEvents}
                  isActiveRun={run.id === activeRunId}
                />
              );
            })}
        </div>
      </div>

      <div className="border-t border-zinc-800 px-4 py-4">
        <form onSubmit={send} className="mx-auto max-w-3xl">
          <div className="flex gap-3">
            <div className="flex-1">
              <Label htmlFor="prompt-input" className="sr-only">
                任务输入
              </Label>
              <Textarea
                id="prompt-input"
                name="prompt"
                autoComplete="off"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="输入任务…（Shift+Enter 换行）"
                rows={1}
                disabled={isLoading || !!activeRunId}
                className="min-h-[44px]"
              />
            </div>
            <Button
              type="submit"
              disabled={isLoading || !!activeRunId || !input.trim()}
              className="min-w-16"
              aria-label={activeRunId ? "Agent 正在运行" : "发送"}
            >
              {activeRunId ? (
                <span
                  className="h-4 w-4 rounded-full border-2 border-zinc-500 border-t-zinc-950 animate-spin"
                  aria-hidden="true"
                />
              ) : (
                "发送"
              )}
            </Button>
          </div>
        </form>
      </div>
      </div>
    </div>
  );
}

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
              <div className="relative">
                <Skeleton className="h-44 w-full rounded-xl" />
                <Skeleton className="absolute bottom-3 right-3 h-10 w-10 rounded-full" />
              </div>
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

      <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto overscroll-contain px-4 py-6">
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col-reverse">
          <div className="flex flex-col">
            {/* 空状态提示（最底部） */}
            {runs.length === 0 && !pendingMessage && (
              <div className="pb-20 text-center text-sm text-zinc-500">
                <p className="text-4xl mb-4" aria-hidden="true">
                  🤖
                </p>
                <p>输入任务，让 Agent 开始工作</p>
              </div>
            )}

            {/* 已完成的轮次（来自 DB，正序渲染；column-reverse 容器负责贴底） */}
            {runs
              .filter((run) => run.id !== pendingMessage?.runId)
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
          </div>
        </div>
      </div>

      <div className="border-t border-zinc-800 px-4 py-4">
        <form onSubmit={send} className="mx-auto max-w-3xl">
          <div className="relative">
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
              rows={6}
              disabled={isLoading || !!activeRunId}
              className="min-h-[160px] w-full resize-none rounded-xl pr-14"
            />
            <Button
              type="submit"
              disabled={isLoading || !!activeRunId || !input.trim()}
              size="icon"
              className="absolute bottom-3 right-3 h-10 w-10 rounded-full"
              aria-label={activeRunId ? "Agent 正在运行" : "发送"}
            >
              {activeRunId ? (
                <>
                  {/* 外围转圈的圆环 */}
                  <span
                    className="absolute inset-[-4px] rounded-full border-2 border-zinc-700 border-t-zinc-400 animate-spin"
                    aria-hidden="true"
                  />
                  {/* 中心的暂停图标或点 */}
                  <span className="w-2 h-2 rounded-full bg-white" aria-hidden="true" />
                </>
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-5 w-5"
                  aria-hidden="true"
                >
                  <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                </svg>
              )}
            </Button>
          </div>
        </form>
      </div>
      </div>
    </div>
  );
}

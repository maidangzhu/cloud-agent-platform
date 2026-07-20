"use client";

import { ExternalLinkIcon, GaugeIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { ArtifactPreview } from "./artifact-preview";
import { Greeting } from "./greeting";
import { RunEventList } from "./run-events";
import { Skeleton } from "@/components/ui/skeleton";
import type { ChatRunState, ChatState } from "@/lib/chat-runtime";
import type {
  LoadState,
  RunSource,
  RunUsageRecord,
  Thread,
} from "./types";

export function ConversationMessages({
  activeThread,
  chat,
  error,
  loadState,
}: {
  activeThread: Thread | null;
  chat: ChatState;
  error: string;
  loadState: LoadState;
}) {
  const showGreeting = !activeThread && loadState === "ready";
  const isLoading = loadState === "loading" || chat.phase === "loading";
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(false);
  const contentVersion = useMemo(
    () =>
      chat.runOrder
        .map((runId) => {
          const view = chat.runs[runId];
          return `${runId}:${view?.events.length ?? 0}:${view?.chunks.length ?? 0}:${view?.artifacts.length ?? 0}`;
        })
        .join("|"),
    [chat.runOrder, chat.runs]
  );

  useEffect(() => {
    userScrolled.current = false;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [activeThread?.id]);

  useEffect(() => {
    if (!userScrolled.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [contentVersion]);

  return (
    <div className="relative flex-1 bg-background">
      {showGreeting && (
        <div className="pointer-events-none absolute inset-x-0 top-[28%] z-10 flex justify-center md:top-[32%]">
          <Greeting />
        </div>
      )}
      <div
        className={
          "absolute inset-0 touch-pan-y overflow-y-auto " +
          (activeThread || loadState !== "ready" ? "bg-background" : "bg-transparent")
        }
        onScroll={() => {
          const element = scrollRef.current;
          if (!element) return;
          userScrolled.current =
            element.scrollHeight - element.scrollTop - element.clientHeight > 80;
        }}
        ref={scrollRef}
      >
        <div className="mx-auto flex min-h-full min-w-0 max-w-3xl flex-col gap-6 px-4 py-6 md:px-6 md:py-8">
          {loadState === "error" && <ErrorBanner title="Could not load workspace" error={error} />}
          {isLoading ? (
            <ThreadLoadingSkeleton />
          ) : chat.phase === "error" ? (
            <ErrorBanner title="Could not load conversation" error={chat.error} />
          ) : activeThread ? (
            <ThreadConversation chat={chat} />
          ) : null}
          <div className="min-h-28 min-w-6 shrink-0 md:min-h-32" />
        </div>
      </div>
    </div>
  );
}

function ThreadLoadingSkeleton() {
  return (
    <div
      aria-label="Loading conversation"
      className="flex min-w-0 flex-col gap-6"
      data-testid="thread-loading-skeleton"
      role="status"
    >
      <span className="sr-only">Loading conversation</span>
      <div className="flex justify-end">
        <Skeleton className="h-11 w-[min(72%,28rem)] rounded-xl" />
      </div>
      <div className="flex items-start gap-3">
        <Skeleton className="size-7 shrink-0 rounded-md" />
        <div className="min-w-0 flex-1 space-y-3 pt-1">
          <Skeleton className="h-4 w-32 rounded-md" />
          <Skeleton className="h-3.5 w-[92%] rounded-md" />
          <Skeleton className="h-3.5 w-[84%] rounded-md" />
          <Skeleton className="h-3.5 w-[68%] rounded-md" />
        </div>
      </div>
    </div>
  );
}

function ErrorBanner({ title, error }: { title: string; error: string }) {
  return (
    <div className="message-fade-in border-l-2 border-destructive px-3 py-1 text-[13px] leading-6">
      <div className="font-medium text-destructive">{title}</div>
      <p className="mt-1 text-muted-foreground">{error}</p>
    </div>
  );
}

function ThreadConversation({ chat }: { chat: ChatState }) {
  return (
    <>
      {chat.runOrder.map((runId) => {
        const view = chat.runs[runId];
        if (!view) return null;
        const turnMessages = chat.messages.filter((message) => message.runId === runId);
        const userPrompt =
          turnMessages.find((message) => message.role === "user")?.content ??
          view.run.prompt;
        const assistantContent = turnMessages
          .filter((message) => message.role === "assistant")
          .map((message) => message.content)
          .join("\n\n");
        const isCurrent = runId === chat.activeRunId;

        return (
          <RunTurn
            assistantContent={assistantContent}
            chat={chat}
            isCurrent={isCurrent}
            key={runId}
            userPrompt={userPrompt}
            view={view}
          />
        );
      })}
    </>
  );
}

function RunTurn({
  assistantContent,
  chat,
  isCurrent,
  userPrompt,
  view,
}: {
  assistantContent: string;
  chat: ChatState;
  isCurrent: boolean;
  userPrompt: string;
  view: ChatRunState;
}) {
  const primaryArtifact = view.artifacts[0];

  return (
    <div className="contents" data-run-id={view.run.id}>
      <div className="message-fade-in flex justify-end">
        <div className="w-fit max-w-[min(88%,60ch)] overflow-hidden break-words rounded-xl bg-secondary px-3.5 py-2.5 text-[14px] leading-6 text-secondary-foreground">
          {userPrompt}
        </div>
      </div>

      <RunEventList
        connection={isCurrent ? chat.connection : "closed"}
        error={isCurrent ? chat.error : ""}
        fallbackContent={assistantContent}
        isCurrent={isCurrent}
        view={view}
      />

      {primaryArtifact && (
        <div className="message-fade-in ml-10">
          <ArtifactPreview
            artifact={{
              id: primaryArtifact.id,
              title: primaryArtifact.title,
              kind: primaryArtifact.kind,
              content: primaryArtifact.contentSnapshot,
              status: "idle",
            }}
          />
        </div>
      )}

      {(view.sources.length > 0 || view.usage.length > 0) && (
        <RunFacts sources={view.sources} usage={view.usage} />
      )}
    </div>
  );
}

function RunFacts({
  sources,
  usage,
}: {
  sources: RunSource[];
  usage: RunUsageRecord[];
}) {
  const totalTokens = usage.reduce(
    (sum, record) => sum + (record.totalTokens ?? 0),
    0
  );
  const firstTokenMs = usage.find((record) => record.ttfbMs !== undefined)?.ttfbMs;
  const durationMs = usage.reduce(
    (sum, record) => sum + (record.durationMs ?? 0),
    0
  );

  return (
    <div className="message-fade-in ml-10 flex flex-wrap items-start gap-x-5 gap-y-2 border-t border-border pt-3 text-[12px] text-muted-foreground">
      {sources.length > 0 && (
        <details className="group min-w-0" data-testid="run-sources">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 hover:text-foreground">
            Sources <span className="tabular-nums">{sources.length}</span>
          </summary>
          <div className="mt-2 grid max-w-md gap-1.5 rounded-md border border-border bg-card p-3">
            {sources.map((source) => {
              const label = source.title || source.uri || source.kind;
              return source.uri ? (
                <a
                  className="flex min-w-0 items-center gap-2 hover:text-foreground"
                  href={source.uri}
                  key={source.id}
                  rel="noreferrer"
                  target="_blank"
                >
                  <span className="truncate">{label}</span>
                  <ExternalLinkIcon className="size-3 shrink-0" />
                </a>
              ) : (
                <div className="truncate" key={source.id}>{label}</div>
              );
            })}
          </div>
        </details>
      )}

      <div className="flex items-center gap-1.5" data-testid="run-usage">
        <GaugeIcon className="size-3.5" />
        <span>{formatInteger(totalTokens)} tokens</span>
        <span className="text-border">/</span>
        <span>{usage.length} calls</span>
        {firstTokenMs !== undefined && (
          <><span className="text-border">/</span><span>{formatDuration(firstTokenMs)} first token</span></>
        )}
        {durationMs > 0 && (
          <><span className="text-border">/</span><span>{formatDuration(durationMs)} total</span></>
        )}
      </div>
    </div>
  );
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDuration(value?: number) {
  if (value === undefined || value === 0) return "-";
  return value < 1_000 ? `${value} ms` : `${(value / 1_000).toFixed(1)} s`;
}

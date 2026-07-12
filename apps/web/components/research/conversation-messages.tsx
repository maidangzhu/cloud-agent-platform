"use client";

import {
  ExternalLinkIcon,
  GaugeIcon,
  Loader2Icon,
  SparklesIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { ArtifactPreview } from "./artifact-preview";
import { Greeting } from "./greeting";
import { RunEventList, type RunEventDTO, type StreamChunkDTO } from "./run-events";
import type {
  AgentRun,
  CurrentUser,
  LoadState,
  RunArtifact,
  RunSource,
  RunUsageRecord,
  Thread,
  ThreadMessage,
} from "./types";

export function ConversationMessages({
  activeThread,
  error,
  loadState,
  run,
  runArtifacts = [],
  runError,
  runEvents = [],
  runSources = [],
  runUsage = [],
  streamChunks = [],
  threadMessages = [],
  user,
}: {
  activeThread: Thread | null;
  error: string;
  loadState: LoadState;
  run: AgentRun | null;
  runArtifacts?: RunArtifact[];
  runError: string;
  runEvents?: RunEventDTO[];
  runSources?: RunSource[];
  runUsage?: RunUsageRecord[];
  streamChunks?: StreamChunkDTO[];
  threadMessages?: ThreadMessage[];
  user: CurrentUser | null;
}) {
  const showGreeting = !activeThread && loadState !== "loading";
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(false);

  useEffect(() => {
    userScrolled.current = false;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [activeThread?.id]);

  useEffect(() => {
    if (!userScrolled.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [runEvents.length, streamChunks.length, runArtifacts.length]);

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
          <SystemBanner error={error} loadState={loadState} user={user} />
          {activeThread ? (
            <ThreadReadyState
              events={runEvents}
              run={run}
              runArtifacts={runArtifacts}
              runError={runError}
              runSources={runSources}
              runUsage={runUsage}
              streamChunks={streamChunks}
              thread={activeThread}
              threadMessages={threadMessages}
            />
          ) : null}
          <div className="min-h-28 min-w-6 shrink-0 md:min-h-32" />
        </div>
      </div>
    </div>
  );
}

function SystemBanner({
  error,
  loadState,
}: {
  error: string;
  loadState: LoadState;
  user: CurrentUser | null;
}) {
  if (loadState === "unauthorized") {
    return (
      <div className="message-fade-in border-l-2 border-border px-3 py-1 text-[13px] leading-6">
        <div className="font-medium">Not signed in</div>
        <p className="mt-1 text-muted-foreground">
          Sign in through the API auth flow, then this workspace will load your
          real workspaces and threads.
        </p>
      </div>
    );
  }
  if (loadState === "error") {
    return (
      <div className="message-fade-in border-l-2 border-destructive px-3 py-1 text-[13px] leading-6">
        <div className="font-medium text-destructive">API snapshot failed</div>
        <p className="mt-1 text-muted-foreground">{error}</p>
      </div>
    );
  }
  if (loadState === "loading") {
    return (
      <div className="message-fade-in flex items-center gap-2 py-2 text-[13px] text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
        Loading workspace snapshot
      </div>
    );
  }
  return null;
}

function ThreadReadyState({
  events,
  run,
  runArtifacts,
  runError,
  runSources,
  runUsage,
  streamChunks,
  thread,
  threadMessages,
}: {
  events: RunEventDTO[];
  run: AgentRun | null;
  runArtifacts: RunArtifact[];
  runError: string;
  runSources: RunSource[];
  runUsage: RunUsageRecord[];
  streamChunks: StreamChunkDTO[];
  thread: Thread;
  threadMessages: ThreadMessage[];
}) {
  const userPrompt =
    run?.prompt ||
    [...threadMessages].reverse().find((message) => message.role === "user")
      ?.content;
  const primaryArtifact = runArtifacts[0];
  const hasLiveOutput = events.length > 0 || streamChunks.length > 0;

  return (
    <>
      {userPrompt && (
        <div className="message-fade-in flex justify-end">
          <div className="w-fit max-w-[min(88%,60ch)] overflow-hidden break-words rounded-xl bg-secondary px-3.5 py-2.5 text-[14px] leading-6 text-secondary-foreground">
            {userPrompt}
          </div>
        </div>
      )}

      {runError && (
        <div className="message-fade-in ml-10 border-l-2 border-destructive px-3 py-1 text-[13px] leading-6">
          <div className="font-medium text-destructive">Run snapshot failed</div>
          <p className="mt-1 text-muted-foreground">{runError}</p>
        </div>
      )}

      {!hasLiveOutput && run && (
        <div className="message-fade-in flex items-start gap-3">
          <div className="flex shrink-0 items-center">
            <div className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary">
              <SparklesIcon size={13} />
            </div>
          </div>
          <div className="flex items-center gap-2 py-1 text-[13px] leading-6 text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            Starting research...
          </div>
        </div>
      )}

      {hasLiveOutput && (
        <RunEventList events={events} streamChunks={streamChunks} />
      )}

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

      {(runSources.length > 0 || runUsage.length > 0) && (
        <RunFacts sources={runSources} usage={runUsage} />
      )}
    </>
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

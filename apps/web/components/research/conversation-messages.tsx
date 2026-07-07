"use client";

import { Loader2Icon, SparklesIcon } from "lucide-react";
import { ArtifactPreview } from "./artifact-preview";
import { Greeting } from "./greeting";
import { RunEventList, type RunEventDTO, type StreamChunkDTO } from "./run-events";
import type {
  AgentRun,
  CurrentUser,
  LoadState,
  RunArtifact,
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
  streamChunks?: StreamChunkDTO[];
  threadMessages?: ThreadMessage[];
  user: CurrentUser | null;
}) {
  const showGreeting = !activeThread && loadState !== "loading";

  return (
    <div className="relative flex-1 bg-background">
      {showGreeting && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <Greeting />
        </div>
      )}
      <div
        className={
          "absolute inset-0 touch-pan-y overflow-y-auto " +
          (activeThread || loadState !== "ready" ? "bg-background" : "bg-transparent")
        }
      >
        <div className="mx-auto flex min-h-full min-w-0 max-w-4xl flex-col gap-5 px-2 py-6 md:gap-7 md:px-4">
          <SystemBanner error={error} loadState={loadState} user={user} />
          {activeThread ? (
            <ThreadReadyState
              events={runEvents}
              run={run}
              runArtifacts={runArtifacts}
              runError={runError}
              streamChunks={streamChunks}
              thread={activeThread}
              threadMessages={threadMessages}
            />
          ) : null}
          <div className="min-h-[220px] min-w-[24px] shrink-0 md:min-h-[240px]" />
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
      <div className="message-fade-in rounded-2xl border border-border/50 bg-card px-4 py-3 text-[13px] leading-6 shadow-[var(--shadow-card)]">
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
      <div className="message-fade-in rounded-2xl border border-destructive/30 bg-card px-4 py-3 text-[13px] leading-6 shadow-[var(--shadow-card)]">
        <div className="font-medium text-destructive">API snapshot failed</div>
        <p className="mt-1 text-muted-foreground">{error}</p>
      </div>
    );
  }
  if (loadState === "loading") {
    return (
      <div className="message-fade-in flex items-center gap-2 rounded-2xl border border-border/50 bg-card px-4 py-3 text-[13px] text-muted-foreground shadow-[var(--shadow-card)]">
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
  streamChunks,
  thread,
  threadMessages,
}: {
  events: RunEventDTO[];
  run: AgentRun | null;
  runArtifacts: RunArtifact[];
  runError: string;
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
          <div className="w-fit max-w-[min(80%,56ch)] overflow-hidden break-words rounded-2xl rounded-br-lg border border-border/30 bg-gradient-to-br from-secondary to-muted px-3.5 py-2 text-[13px] leading-[1.65] shadow-[var(--shadow-card)]">
            {userPrompt}
          </div>
        </div>
      )}

      {runError && (
        <div className="message-fade-in ml-10 rounded-2xl border border-destructive/30 bg-card px-4 py-3 text-[13px] leading-6 shadow-[var(--shadow-card)]">
          <div className="font-medium text-destructive">Run snapshot failed</div>
          <p className="mt-1 text-muted-foreground">{runError}</p>
        </div>
      )}

      {!hasLiveOutput && run && (
        <div className="message-fade-in flex items-start gap-3">
          <div className="flex h-[calc(13px*1.65)] shrink-0 items-center">
            <div className="flex size-7 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground ring-1 ring-border/50">
              <SparklesIcon size={13} />
            </div>
          </div>
          <div className="w-fit max-w-[min(88%,62ch)] rounded-2xl border border-border/50 bg-card px-4 py-3 text-[13px] leading-6 text-muted-foreground shadow-[var(--shadow-card)]">
            Starting research...
          </div>
        </div>
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

      {hasLiveOutput && (
        <div className="message-fade-in ml-10">
          <RunEventList events={events} streamChunks={streamChunks} />
        </div>
      )}
    </>
  );
}

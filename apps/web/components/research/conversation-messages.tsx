"use client";

import { Loader2Icon, PlusIcon, SparklesIcon } from "lucide-react";
import { ArtifactPreview } from "./artifact-preview";
import { Greeting } from "./greeting";
import { RunEventList, type RunEventDTO, type StreamChunkDTO } from "./run-events";
import type {
  AgentRun,
  CurrentUser,
  LoadState,
  RunArtifact,
  RunSource,
  Thread,
  ThreadMessage,
  Workspace,
} from "./types";

export function ConversationMessages({
  activeThread,
  activeWorkspace,
  error,
  loadState,
  onCreateThread,
  onCreateWorkspace,
  run,
  runArtifacts = [],
  runError,
  runEvents = [],
  runSources = [],
  streamChunks = [],
  threadMessages = [],
  user,
}: {
  activeWorkspace: Workspace | null;
  activeThread: Thread | null;
  error: string;
  loadState: LoadState;
  onCreateWorkspace: () => void;
  onCreateThread: () => void;
  run: AgentRun | null;
  runArtifacts?: RunArtifact[];
  runError: string;
  runEvents?: RunEventDTO[];
  runSources?: RunSource[];
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
              runSources={runSources}
              streamChunks={streamChunks}
              thread={activeThread}
              threadMessages={threadMessages}
              workspace={activeWorkspace}
            />
          ) : loadState === "ready" ? (
            <EmptyThreadState
              activeWorkspace={activeWorkspace}
              onCreateThread={onCreateThread}
              onCreateWorkspace={onCreateWorkspace}
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

function EmptyThreadState({
  activeWorkspace,
  onCreateThread,
  onCreateWorkspace,
}: {
  activeWorkspace: Workspace | null;
  onCreateWorkspace: () => void;
  onCreateThread: () => void;
}) {
  return (
    <div className="message-fade-in mt-[30vh] rounded-2xl border border-border/50 bg-card/80 p-5 shadow-[var(--shadow-card)] backdrop-blur-sm md:mt-[34vh]">
      <div className="text-sm font-medium">
        {activeWorkspace ? "No thread selected" : "No workspace selected"}
      </div>
      <p className="mt-1 max-w-xl text-[13px] leading-6 text-muted-foreground">
        {activeWorkspace
          ? "Create a thread in this workspace to start the research path."
          : "Create a workspace first; threads and runs belong inside it."}
      </p>
      <div className="mt-4 flex gap-2">
        {activeWorkspace ? (
          <button
            className="inline-flex h-8 items-center gap-2 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
            onClick={onCreateThread}
            type="button"
          >
            <PlusIcon className="size-4" />
            New thread
          </button>
        ) : (
          <button
            className="inline-flex h-8 items-center gap-2 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
            onClick={onCreateWorkspace}
            type="button"
          >
            <PlusIcon className="size-4" />
            New workspace
          </button>
        )}
      </div>
    </div>
  );
}

function ThreadReadyState({
  events,
  run,
  runArtifacts,
  runError,
  runSources,
  streamChunks,
  thread,
  threadMessages,
  workspace,
}: {
  events: RunEventDTO[];
  run: AgentRun | null;
  runArtifacts: RunArtifact[];
  runError: string;
  runSources: RunSource[];
  streamChunks: StreamChunkDTO[];
  thread: Thread;
  threadMessages: ThreadMessage[];
  workspace: Workspace | null;
}) {
  const userPrompt =
    run?.prompt ||
    [...threadMessages].reverse().find((message) => message.role === "user")
      ?.content ||
    thread.title;
  const primaryArtifact = runArtifacts[0];

  return (
    <>
      <div className="message-fade-in flex justify-end">
        <div className="w-fit max-w-[min(80%,56ch)] overflow-hidden break-words rounded-2xl rounded-br-lg border border-border/30 bg-gradient-to-br from-secondary to-muted px-3.5 py-2 text-[13px] leading-[1.65] shadow-[var(--shadow-card)]">
          {userPrompt}
        </div>
      </div>

      {runError && (
        <div className="message-fade-in ml-10 rounded-2xl border border-destructive/30 bg-card px-4 py-3 text-[13px] leading-6 shadow-[var(--shadow-card)]">
          <div className="font-medium text-destructive">Run snapshot failed</div>
          <p className="mt-1 text-muted-foreground">{runError}</p>
        </div>
      )}

      <div className="message-fade-in flex items-start gap-3">
        <div className="flex h-[calc(13px*1.65)] shrink-0 items-center">
          <div className="flex size-7 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground ring-1 ring-border/50">
            <SparklesIcon size={13} />
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="w-fit max-w-[min(88%,62ch)] rounded-2xl border border-border/50 bg-card px-4 py-3 text-[13px] leading-6 shadow-[var(--shadow-card)]">
            {run
              ? `Run ${run.derivedUiState || run.status}.`
              : "This thread is selected. Start a run from the composer."}
          </div>
          <ArtifactPreview
            artifact={
              primaryArtifact
                ? {
                    id: primaryArtifact.id,
                    title: primaryArtifact.title,
                    kind: primaryArtifact.kind,
                    content: primaryArtifact.contentSnapshot,
                    status: "idle",
                  }
                : undefined
            }
          />
        </div>
      </div>

      <div className="message-fade-in ml-10 grid gap-2">
        {[
          ["Workspace", workspace?.title ?? "Selected workspace"],
          ["Thread", thread.title],
          ["Thread status", thread.status],
          ["Run status", run?.status ?? "no run"],
          ["Sources", String(runSources.length)],
        ].map(([label, value]) => (
          <div
            className="flex max-w-[450px] items-center justify-between rounded-xl border border-border/50 bg-card px-3 py-2 text-[13px] shadow-[var(--shadow-card)]"
            key={label}
          >
            <span className="text-muted-foreground">{label}</span>
            <span className="min-w-0 truncate font-medium">{value}</span>
          </div>
        ))}
      </div>

      <div className="message-fade-in ml-10">
        <RunEventList events={events} streamChunks={streamChunks} />
      </div>
    </>
  );
}

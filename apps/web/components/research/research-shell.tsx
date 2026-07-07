"use client";

import { useEffect } from "react";
import { Composer } from "./composer";
import { ConversationMessages } from "./conversation-messages";
import { ArtifactPanel } from "./artifact-panel";
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
import type { RunEventDTO, StreamChunkDTO } from "./run-events";
import { WorkspaceThreadHeader } from "./workspace-thread-header";
import {
  ArtifactProvider,
  initialArtifactData,
  useArtifact,
  useArtifactSelector,
} from "@/hooks/use-artifact";

export function ResearchShell({
  activeThread,
  activeWorkspace,
  error,
  isCancellingRun,
  isStartingRun,
  loadState,
  onCancelRun,
  onCreateThread,
  onCreateWorkspace,
  onStartRun,
  run,
  runArtifacts,
  runError,
  runEvents,
  runSources,
  streamChunks,
  threadMessages,
  user,
}: {
  activeWorkspace: Workspace | null;
  activeThread: Thread | null;
  error: string;
  isCancellingRun: boolean;
  isStartingRun: boolean;
  loadState: LoadState;
  onCancelRun: () => void;
  onCreateWorkspace: () => void;
  onCreateThread: () => void;
  onStartRun: (prompt: string) => Promise<boolean>;
  run: AgentRun | null;
  runArtifacts: RunArtifact[];
  runError: string;
  runEvents: RunEventDTO[];
  runSources: RunSource[];
  streamChunks: StreamChunkDTO[];
  threadMessages: ThreadMessage[];
  user: CurrentUser | null;
}) {
  return (
    <ArtifactProvider>
      <ResearchShellContent
        activeThread={activeThread}
        activeWorkspace={activeWorkspace}
        error={error}
        isCancellingRun={isCancellingRun}
        isStartingRun={isStartingRun}
        loadState={loadState}
        onCancelRun={onCancelRun}
        onCreateThread={onCreateThread}
        onCreateWorkspace={onCreateWorkspace}
        onStartRun={onStartRun}
        run={run}
        runArtifacts={runArtifacts}
        runError={runError}
        runEvents={runEvents}
        runSources={runSources}
        streamChunks={streamChunks}
        threadMessages={threadMessages}
        user={user}
      />
    </ArtifactProvider>
  );
}

function ResearchShellContent({
  activeThread,
  activeWorkspace,
  error,
  isCancellingRun,
  isStartingRun,
  loadState,
  onCancelRun,
  onCreateThread,
  onCreateWorkspace,
  onStartRun,
  run,
  runArtifacts,
  runError,
  runEvents,
  runSources,
  streamChunks,
  threadMessages,
  user,
}: {
  activeWorkspace: Workspace | null;
  activeThread: Thread | null;
  error: string;
  isCancellingRun: boolean;
  isStartingRun: boolean;
  loadState: LoadState;
  onCancelRun: () => void;
  onCreateWorkspace: () => void;
  onCreateThread: () => void;
  onStartRun: (prompt: string) => Promise<boolean>;
  run: AgentRun | null;
  runArtifacts: RunArtifact[];
  runError: string;
  runEvents: RunEventDTO[];
  runSources: RunSource[];
  streamChunks: StreamChunkDTO[];
  threadMessages: ThreadMessage[];
  user: CurrentUser | null;
}) {
  const isArtifactVisible = useArtifactSelector((state) => state.isVisible);
  const { setArtifact } = useArtifact();

  useEffect(() => {
    setArtifact(initialArtifactData);
  }, [activeThread?.id, setArtifact]);

  return (
    <div className="flex h-dvh w-full flex-row overflow-hidden">
      <div
        className={
          "flex min-w-0 flex-col bg-sidebar transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] " +
          (isArtifactVisible ? "w-[40%]" : "w-full")
        }
      >
        <WorkspaceThreadHeader
          activeThread={activeThread}
          activeWorkspace={activeWorkspace}
          state={loadState}
        />
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background md:rounded-tl-[12px] md:border-l md:border-t md:border-border/40">
          <ConversationMessages
            activeThread={activeThread}
            activeWorkspace={activeWorkspace}
            error={error}
            loadState={loadState}
            onCreateThread={onCreateThread}
            onCreateWorkspace={onCreateWorkspace}
            run={run}
            runArtifacts={runArtifacts}
            runError={runError}
            runEvents={runEvents}
            runSources={runSources}
            streamChunks={streamChunks}
            threadMessages={threadMessages}
            user={user}
          />
          <div className="sticky bottom-0 z-1 mx-auto flex w-full max-w-4xl gap-2 border-t-0 bg-background px-2 pb-3 md:px-4 md:pb-4">
            <Composer
              activeThread={activeThread}
              activeWorkspace={activeWorkspace}
              isCancellingRun={isCancellingRun}
              isStartingRun={isStartingRun}
              loadState={loadState}
              onCancelRun={onCancelRun}
              onCreateThread={onCreateThread}
              onCreateWorkspace={onCreateWorkspace}
              onStartRun={onStartRun}
              run={run}
            />
          </div>
        </div>
      </div>

      <ArtifactPanel />
    </div>
  );
}

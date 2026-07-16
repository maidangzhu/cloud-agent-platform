"use client";

import { useEffect } from "react";
import { Composer } from "./composer";
import { ConversationMessages } from "./conversation-messages";
import { ArtifactPanel } from "./artifact-panel";
import { AuthPanel, type AuthRequest } from "./auth-panel";
import type {
  AgentRun,
  CurrentUser,
  LoadState,
  RunArtifact,
  RunSource,
  RunUsageRecord,
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
  isThreadLoading,
  loadState,
  onCancelRun,
  onAuthenticate,
  onCreateThread,
  onStartRun,
  run,
  runArtifacts,
  runError,
  runEvents,
  runSources,
  runUsage,
  runs,
  streamChunks,
  threadMessages,
  user,
}: {
  activeWorkspace: Workspace | null;
  activeThread: Thread | null;
  error: string;
  isCancellingRun: boolean;
  isStartingRun: boolean;
  isThreadLoading: boolean;
  loadState: LoadState;
  onCancelRun: () => void;
  onAuthenticate: (request: AuthRequest) => Promise<boolean>;
  onCreateThread: () => void;
  onStartRun: (prompt: string) => Promise<boolean>;
  run: AgentRun | null;
  runArtifacts: RunArtifact[];
  runError: string;
  runEvents: RunEventDTO[];
  runSources: RunSource[];
  runUsage: RunUsageRecord[];
  runs: Array<AgentRun & { events: RunEventDTO[] }>;
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
        isThreadLoading={isThreadLoading}
        loadState={loadState}
        onCancelRun={onCancelRun}
        onAuthenticate={onAuthenticate}
        onCreateThread={onCreateThread}
        onStartRun={onStartRun}
        run={run}
        runArtifacts={runArtifacts}
        runError={runError}
        runEvents={runEvents}
        runSources={runSources}
        runUsage={runUsage}
        runs={runs}
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
  isThreadLoading,
  loadState,
  onCancelRun,
  onAuthenticate,
  onCreateThread,
  onStartRun,
  run,
  runArtifacts,
  runError,
  runEvents,
  runSources,
  runUsage,
  runs,
  streamChunks,
  threadMessages,
  user,
}: {
  activeWorkspace: Workspace | null;
  activeThread: Thread | null;
  error: string;
  isCancellingRun: boolean;
  isStartingRun: boolean;
  isThreadLoading: boolean;
  loadState: LoadState;
  onCancelRun: () => void;
  onAuthenticate: (request: AuthRequest) => Promise<boolean>;
  onCreateThread: () => void;
  onStartRun: (prompt: string) => Promise<boolean>;
  run: AgentRun | null;
  runArtifacts: RunArtifact[];
  runError: string;
  runEvents: RunEventDTO[];
  runSources: RunSource[];
  runUsage: RunUsageRecord[];
  runs: Array<AgentRun & { events: RunEventDTO[] }>;
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
          "flex min-w-0 flex-col bg-background transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] " +
          (isArtifactVisible ? "w-[42%]" : "w-full")
        }
      >
        <WorkspaceThreadHeader
          activeThread={activeThread}
          activeWorkspace={activeWorkspace}
          state={loadState}
        />
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
          {loadState === "unauthorized" ? (
            <AuthPanel error={error} onAuthenticate={onAuthenticate} />
          ) : (
            <>
              <ConversationMessages
                activeThread={activeThread}
                error={error}
                loadState={loadState}
                isThreadLoading={isThreadLoading}
                run={run}
                runArtifacts={runArtifacts}
                runSources={runSources}
                runUsage={runUsage}
                runs={runs}
                runError={runError}
                runEvents={runEvents}
                streamChunks={streamChunks}
                threadMessages={threadMessages}
                user={user}
              />
              <div className="sticky bottom-0 z-10 w-full bg-background/95 px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-2 backdrop-blur md:px-6 md:pb-5">
                <div className="mx-auto w-full max-w-3xl">
                <Composer
                  activeThread={activeThread}
                  activeWorkspace={activeWorkspace}
                  isCancellingRun={isCancellingRun}
                  isStartingRun={isStartingRun}
                  isThreadLoading={isThreadLoading}
                  loadState={loadState}
                  onCancelRun={onCancelRun}
                  onCreateThread={onCreateThread}
                  onStartRun={onStartRun}
                  run={run}
                />
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <ArtifactPanel />
    </div>
  );
}

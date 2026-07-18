"use client";

import { useEffect } from "react";
import { Composer } from "./composer";
import { ConversationMessages } from "./conversation-messages";
import { ArtifactPanel } from "./artifact-panel";
import { AuthPanel, type AuthRequest } from "./auth-panel";
import type { LoadState, Thread, Workspace } from "./types";
import type { ChatState } from "@/lib/chat-runtime";
import { WorkspaceThreadHeader } from "./workspace-thread-header";
import {
  ArtifactProvider,
  initialArtifactData,
  useArtifact,
  useArtifactSelector,
} from "@/hooks/use-artifact";

type ResearchShellProps = {
  activeWorkspace: Workspace | null;
  activeThread: Thread | null;
  chat: ChatState;
  error: string;
  loadState: LoadState;
  onCancelRun: () => void;
  onAuthenticate: (request: AuthRequest) => Promise<boolean>;
  onCreateThread: () => void;
  onStartRun: (prompt: string) => Promise<boolean>;
};

export function ResearchShell(props: ResearchShellProps) {
  return (
    <ArtifactProvider>
      <ResearchShellContent {...props} />
    </ArtifactProvider>
  );
}

function ResearchShellContent({
  activeThread,
  activeWorkspace,
  chat,
  error,
  loadState,
  onCancelRun,
  onAuthenticate,
  onCreateThread,
  onStartRun,
}: ResearchShellProps) {
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
                chat={chat}
                error={error}
                loadState={loadState}
              />
              <div className="sticky bottom-0 z-10 w-full bg-background/95 px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-2 backdrop-blur md:px-6 md:pb-5">
                <div className="mx-auto w-full max-w-3xl">
                  <Composer
                    activeThread={activeThread}
                    activeWorkspace={activeWorkspace}
                    chat={chat}
                    loadState={loadState}
                    onCancelRun={onCancelRun}
                    onCreateThread={onCreateThread}
                    onStartRun={onStartRun}
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

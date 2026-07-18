"use client";

import { PanelRightOpenIcon } from "lucide-react";
import { memo } from "react";
import { Button } from "@/components/ui/button";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { useArtifact } from "@/hooks/use-artifact";
import type { LoadState, Thread, Workspace } from "./types";

function PureWorkspaceThreadHeader({
  activeThread,
  activeWorkspace,
  state,
}: {
  activeThread: Thread | null;
  activeWorkspace: Workspace | null;
  state: LoadState;
}) {
  const { state: sidebarState, isMobile } = useSidebar();
  const { setArtifact } = useArtifact();

  return (
    <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border bg-background px-3 md:px-4">
      {(isMobile || sidebarState === "collapsed") && (
        <SidebarTrigger className="size-8 text-muted-foreground" />
      )}
      <div className="flex min-w-0 items-center gap-2 text-[13px]">
        <span className="max-w-48 truncate font-medium text-foreground">
          {activeWorkspace?.title ?? "Research Workspace"}
        </span>
        {activeThread && (
          <>
            <span className="text-border">/</span>
            <span className="max-w-72 truncate text-muted-foreground">
              {activeThread.title}
            </span>
          </>
        )}
        {!activeThread && state !== "ready" && state !== "idle" && (
          <span className="text-muted-foreground">{headerSubtitle(state)}</span>
        )}
      </div>
      <Button
        aria-label="Open artifact panel"
        className="ml-auto size-8 text-muted-foreground"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setArtifact((currentArtifact) => ({
            ...currentArtifact,
            isVisible: true,
            title: currentArtifact.title || "Artifacts",
            boundingBox: {
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height,
            },
          }));
        }}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <PanelRightOpenIcon className="size-4" />
      </Button>
    </header>
  );
}

export const WorkspaceThreadHeader = memo(PureWorkspaceThreadHeader);

function headerSubtitle(state: LoadState) {
  if (state === "loading") {
    return "Loading workspace";
  }
  if (state === "unauthorized") {
    return "Not signed in";
  }
  if (state === "error") {
    return "API unavailable";
  }
  return "";
}

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

  if (sidebarState === "collapsed" && !isMobile) {
    return null;
  }

  return (
    <header className="sticky top-0 flex h-14 items-center gap-2 bg-sidebar px-3">
      <SidebarTrigger className="md:hidden" />
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium">
          {activeWorkspace?.title ?? "Research workspace"}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {activeThread?.title ?? headerSubtitle(state)}
        </div>
      </div>
      <Button
        aria-label="Open artifact panel"
        className="ml-auto"
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
    return "Loading workspace snapshot";
  }
  if (state === "unauthorized") {
    return "Not signed in";
  }
  if (state === "error") {
    return "API unavailable";
  }
  return "Ready";
}

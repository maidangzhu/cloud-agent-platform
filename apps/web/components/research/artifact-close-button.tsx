"use client";

import { XIcon } from "lucide-react";
import { memo } from "react";
import { initialArtifactData, useArtifact } from "@/hooks/use-artifact";

function PureArtifactCloseButton() {
  const { setArtifact } = useArtifact();

  return (
    <button
      className="group flex size-8 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-all duration-150 hover:border-border hover:bg-muted hover:text-foreground active:scale-95"
      data-testid="artifact-close-button"
      onClick={() => {
        setArtifact((currentArtifact) =>
          currentArtifact.status === "streaming"
            ? { ...currentArtifact, isVisible: false }
            : initialArtifactData
        );
      }}
      type="button"
    >
      <XIcon className="size-4" />
    </button>
  );
}

export const ArtifactCloseButton = memo(PureArtifactCloseButton);

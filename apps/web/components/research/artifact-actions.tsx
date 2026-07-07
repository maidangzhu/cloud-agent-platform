"use client";

import {
  CopyIcon,
  DownloadIcon,
  FileTextIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { UIArtifact } from "@/hooks/use-artifact";

export function ArtifactActions({
  artifact,
  onShowLatest,
  onToggleFooter,
  showFooter,
}: {
  artifact: UIArtifact;
  onShowLatest: () => void;
  onToggleFooter: () => void;
  showFooter: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const hasContent = artifact.content.trim().length > 0;

  async function copyContent() {
    if (!hasContent) {
      return;
    }
    await navigator.clipboard.writeText(artifact.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  function downloadContent() {
    if (!hasContent) {
      return;
    }
    const blob = new Blob([artifact.content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${artifact.title || "artifact"}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const actions = [
    {
      label: copied ? "Copied" : "Copy",
      icon: <CopyIcon className="size-4" />,
      disabled: !hasContent,
      onClick: copyContent,
      active: false,
    },
    {
      label: "Download",
      icon: <DownloadIcon className="size-4" />,
      disabled: !hasContent,
      onClick: downloadContent,
      active: false,
    },
    {
      label: "Versions",
      icon: <FileTextIcon className="size-4" />,
      disabled: false,
      onClick: onToggleFooter,
      active: showFooter,
    },
    {
      label: "Latest",
      icon: <RotateCcwIcon className="size-4" />,
      disabled: false,
      onClick: onShowLatest,
      active: false,
    },
  ];

  return (
    <div className="flex flex-col items-center gap-0.5">
      {actions.map((action) => (
        <Tooltip key={action.label}>
          <TooltipTrigger asChild>
            <button
              aria-label={action.label}
              className={cn(
                "flex items-center justify-center rounded-full p-3 text-muted-foreground transition-all duration-150 hover:text-foreground active:scale-95 disabled:pointer-events-none disabled:opacity-30",
                action.active && "text-foreground"
              )}
              disabled={action.disabled}
              onClick={action.onClick}
              type="button"
            >
              {action.icon}
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={8}>
            {action.label}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

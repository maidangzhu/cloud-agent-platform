"use client";

import { FileTextIcon, FullscreenIcon, Loader2Icon } from "lucide-react";
import { memo, useCallback, useEffect, useRef } from "react";
import {
  type ArtifactKind,
  type UIArtifact,
  useArtifact,
} from "@/hooks/use-artifact";
import { cn } from "@/lib/utils";

export type ArtifactPreviewData = {
  id?: string;
  title?: string;
  kind?: ArtifactKind;
  content?: string;
  status?: UIArtifact["status"];
};

function PureArtifactPreview({
  artifact,
  className,
}: {
  artifact?: ArtifactPreviewData;
  className?: string;
}) {
  const { setArtifact } = useArtifact();
  const hitboxRef = useRef<HTMLDivElement>(null);
  const title = artifact?.title ?? "Artifact preview";
  const kind = artifact?.kind ?? "text";
  const status = artifact?.status ?? "idle";
  const hasContent = Boolean(artifact?.content?.trim());

  useEffect(() => {
    const boundingBox = hitboxRef.current?.getBoundingClientRect();
    if (!boundingBox) {
      return;
    }
    setArtifact((currentArtifact) => ({
      ...currentArtifact,
      boundingBox: {
        left: boundingBox.x,
        top: boundingBox.y,
        width: boundingBox.width,
        height: boundingBox.height,
      },
    }));
  }, [setArtifact]);

  const openArtifact = useCallback(() => {
    const boundingBox = hitboxRef.current?.getBoundingClientRect();
    setArtifact((currentArtifact) => ({
      ...currentArtifact,
      documentId: artifact?.id ?? currentArtifact.documentId,
      kind,
      content: artifact?.content ?? currentArtifact.content,
      title,
      status,
      isVisible: true,
      boundingBox: boundingBox
        ? {
            left: boundingBox.x,
            top: boundingBox.y,
            width: boundingBox.width,
            height: boundingBox.height,
          }
        : currentArtifact.boundingBox,
    }));
  }, [artifact?.content, artifact?.id, kind, setArtifact, status, title]);

  return (
    <div
      className={cn("relative w-full max-w-[450px] cursor-pointer", className)}
    >
      <div
        aria-hidden="true"
        className="absolute left-0 top-0 z-10 size-full rounded-xl"
        onClick={openArtifact}
        ref={hitboxRef}
        role="presentation"
      >
        <div className="flex w-full items-center justify-end p-4">
          <div className="absolute right-[9px] top-[13px] rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <FullscreenIcon className="size-4" />
          </div>
        </div>
      </div>

      <div className="flex flex-row items-center justify-between gap-2 rounded-t-2xl border border-b-0 border-border/50 bg-card px-4 py-3 dark:bg-muted">
        <div className="flex min-w-0 flex-row items-center gap-2.5">
          <div className="text-muted-foreground">
            {status === "streaming" ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <FileTextIcon className="size-4" />
            )}
          </div>
          <div className="truncate text-sm font-medium">{title}</div>
        </div>
        <div className="w-8" />
      </div>

      <div className="h-[257px] overflow-hidden rounded-b-2xl border border-t-0 border-border/50 bg-muted p-6">
        {hasContent ? (
          <div className="relative h-full overflow-hidden text-[13px] leading-6 text-muted-foreground">
            <p className="whitespace-pre-wrap break-words">
              {artifact?.content}
            </p>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-muted to-transparent dark:from-muted" />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="h-4 w-2/3 rounded bg-muted-foreground/15" />
            <div className="h-3 w-full rounded bg-muted-foreground/15" />
            <div className="h-3 w-11/12 rounded bg-muted-foreground/15" />
            <div className="h-3 w-4/5 rounded bg-muted-foreground/15" />
            <div className="mt-5 h-20 rounded-xl border border-border/60 bg-background/70" />
          </div>
        )}
      </div>
    </div>
  );
}

export const ArtifactPreview = memo(PureArtifactPreview);

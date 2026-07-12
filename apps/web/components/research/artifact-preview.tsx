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
      className={cn("relative w-full max-w-[620px] cursor-pointer", className)}
      data-artifact-id={artifact?.id}
      data-testid="artifact-preview"
    >
      <div
        aria-hidden="true"
        className="absolute left-0 top-0 z-10 size-full rounded-md"
        onClick={openArtifact}
        ref={hitboxRef}
        role="presentation"
      >
        <div className="flex w-full items-center justify-end p-4">
          <div className="absolute right-2.5 top-2.5 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <FullscreenIcon className="size-4" />
          </div>
        </div>
      </div>

      <div className="flex flex-row items-center justify-between gap-2 rounded-t-md border border-b-0 border-border bg-card px-3 py-2.5">
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

      <div className="h-44 overflow-hidden rounded-b-md border border-t-0 border-border bg-card px-4 py-3">
        {hasContent ? (
          <div className="relative h-full overflow-hidden text-[13px] leading-6 text-foreground/80">
            <p className="whitespace-pre-wrap break-words">
              {artifact?.content}
            </p>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card to-transparent" />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="h-4 w-2/3 rounded bg-muted-foreground/15" />
            <div className="h-3 w-full rounded bg-muted-foreground/15" />
            <div className="h-3 w-11/12 rounded bg-muted-foreground/15" />
            <div className="h-3 w-4/5 rounded bg-muted-foreground/15" />
            <div className="mt-5 h-16 rounded-md border border-border bg-background/70" />
          </div>
        )}
      </div>
    </div>
  );
}

export const ArtifactPreview = memo(PureArtifactPreview);

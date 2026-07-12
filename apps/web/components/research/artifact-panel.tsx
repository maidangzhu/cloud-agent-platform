"use client";

import { AnimatePresence, motion } from "framer-motion";
import { FileTextIcon, Loader2Icon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useWindowSize } from "usehooks-ts";
import { useArtifact } from "@/hooks/use-artifact";
import { ArtifactActions } from "./artifact-actions";
import { ArtifactCloseButton } from "./artifact-close-button";
import { ArtifactVersionFooter } from "./artifact-version-footer";

export function ArtifactPanel() {
  const { artifact, setArtifact } = useArtifact();
  const [mode, setMode] = useState<"edit" | "diff">("edit");
  const [showFooter, setShowFooter] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const userScrolledArtifact = useRef(false);
  const { width: windowWidth, height: windowHeight } = useWindowSize();
  const isMobile = windowWidth ? windowWidth < 768 : false;

  useEffect(() => {
    if (artifact.status !== "streaming") {
      userScrolledArtifact.current = false;
      return;
    }
    if (userScrolledArtifact.current) {
      return;
    }
    const element = contentRef.current;
    if (element) {
      element.scrollTo({ top: element.scrollHeight });
    }
  }, [artifact.content, artifact.status]);

  if (!artifact.isVisible) {
    return (
      <div
        className="h-dvh w-0 shrink-0 overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
        data-testid="artifact"
      />
    );
  }

  const hasContent = artifact.content.trim().length > 0;
  const title = artifact.title || "Artifacts";

  const panel = (
    <>
      <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex min-w-0 items-center gap-3">
            <ArtifactCloseButton />
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="truncate text-[13px] font-medium leading-tight">
                {title}
              </div>
              <ArtifactSubheading status={artifact.status} hasContent={hasContent} />
            </div>
          </div>
          <button
            aria-label="Search artifact"
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            disabled
            type="button"
          >
            <SearchIcon className="size-4" />
          </button>
      </div>

      <div
        className="relative flex-1 overflow-y-auto bg-background"
        data-slot="artifact-content"
        onScroll={() => {
          const element = contentRef.current;
          if (!element) {
            return;
          }
          const atBottom =
            element.scrollHeight - element.scrollTop - element.clientHeight < 40;
          userScrolledArtifact.current = !atBottom;
        }}
        ref={contentRef}
      >
        <ArtifactContent content={artifact.content} mode={mode} title={title} />
        <div className="fixed bottom-5 right-4 z-50 rounded-lg border border-border bg-background/95 py-1 shadow-[var(--shadow-float)] backdrop-blur md:right-5">
          <ArtifactActions
            artifact={artifact}
            onShowLatest={() => {
              setMode("edit");
              setShowFooter(false);
            }}
            onToggleFooter={() => setShowFooter((current) => !current)}
            showFooter={showFooter}
          />
        </div>
      </div>

      <AnimatePresence>
        {showFooter && (
          <ArtifactVersionFooter
            mode={mode}
            onLatest={() => {
              setMode("edit");
              setShowFooter(false);
            }}
            onToggleMode={() =>
              setMode((currentMode) =>
                currentMode === "edit" ? "diff" : "edit"
              )
            }
          />
        )}
      </AnimatePresence>
    </>
  );

  if (isMobile) {
    return (
      <motion.div
        animate={{
          opacity: 1,
          x: 0,
          y: 0,
          height: windowHeight,
          width: "100dvw",
          borderRadius: 0,
        }}
        className="fixed inset-0 z-50 flex h-dvh flex-col overflow-hidden bg-sidebar"
        data-testid="artifact"
        exit={{ opacity: 0, scale: 0.95 }}
        initial={{
          opacity: 1,
          x: artifact.boundingBox.left,
          y: artifact.boundingBox.top,
          height: artifact.boundingBox.height || 32,
          width: artifact.boundingBox.width || 32,
          borderRadius: 50,
        }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
      >
        {panel}
      </motion.div>
    );
  }

  return (
    <div
      className="flex h-dvh w-[58%] shrink-0 flex-col overflow-hidden border-l border-border bg-background transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
      data-testid="artifact"
    >
      {panel}
    </div>
  );
}

function ArtifactSubheading({
  hasContent,
  status,
}: {
  hasContent: boolean;
  status: "streaming" | "idle" | "failed";
}) {
  if (status === "streaming") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2Icon className="size-3 animate-spin" />
        Generating...
      </div>
    );
  }
  if (status === "failed") {
    return <div className="text-xs text-destructive">Generation failed</div>;
  }
  return (
    <div className="truncate text-xs text-muted-foreground">
      {hasContent ? "Latest snapshot" : "No artifact content yet"}
    </div>
  );
}

function ArtifactContent({
  content,
  mode,
  title,
}: {
  content: string;
  mode: "edit" | "diff";
  title: string;
}) {
  if (!content.trim()) {
    return (
      <div className="flex min-h-full items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm text-[13px] leading-6">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium">
            <FileTextIcon className="size-4 text-muted-foreground" />
            Artifact
          </div>
          <p className="text-muted-foreground">
            Artifact output will appear here after a run creates or updates one.
          </p>
        </div>
      </div>
    );
  }

  return (
    <article className="mx-auto min-h-full max-w-3xl px-6 py-8 pr-20 text-[14px] leading-7 md:px-10 md:py-10">
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-normal">{title}</h1>
        {mode === "diff" && (
          <p className="mt-2 text-xs text-muted-foreground">
            Diff mode is ready for version history once the API supplies prior
            snapshots.
          </p>
        )}
      </div>
      <div className="prose prose-sm max-w-none break-words text-foreground prose-headings:font-semibold prose-headings:tracking-normal prose-p:leading-7 prose-a:text-primary prose-pre:overflow-x-auto prose-pre:rounded-md prose-pre:border prose-pre:border-border prose-pre:bg-muted dark:prose-invert">
        <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
      </div>
    </article>
  );
}

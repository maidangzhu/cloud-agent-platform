"use client";

import { motion } from "framer-motion";
import { ChevronLeftIcon, ChevronRightIcon, DiffIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function ArtifactVersionFooter({
  mode,
  onLatest,
  onToggleMode,
}: {
  mode: "edit" | "diff";
  onLatest: () => void;
  onToggleMode: () => void;
}) {
  return (
    <motion.div
      animate={{ opacity: 1 }}
      className="z-50 flex w-full shrink-0 items-center justify-between gap-3 border-t border-border/50 bg-background px-4 py-3"
      exit={{ opacity: 0, transition: { duration: 0 } }}
      initial={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <button
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            disabled
            type="button"
          >
            <ChevronLeftIcon className="size-4" />
          </button>
          <span className="min-w-[4rem] text-center text-xs tabular-nums text-muted-foreground">
            1 of 1
          </span>
          <button
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            disabled
            type="button"
          >
            <ChevronRightIcon className="size-4" />
          </button>
        </div>

        <button
          className={cn(
            "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            mode === "diff" && "bg-muted text-foreground"
          )}
          onClick={onToggleMode}
          title="Show changes"
          type="button"
        >
          <DiffIcon className="size-4" />
        </button>
      </div>

      <div className="flex flex-row gap-2">
        <button
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-foreground px-3 py-1.5 text-sm font-medium text-background transition-all duration-150 hover:opacity-90 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
          disabled
          type="button"
        >
          Restore
        </button>
        <button
          className="inline-flex items-center justify-center rounded-lg border border-border px-3 py-1.5 text-sm font-medium transition-all duration-150 hover:bg-muted active:scale-[0.98]"
          onClick={onLatest}
          type="button"
        >
          Latest
        </button>
      </div>
    </motion.div>
  );
}

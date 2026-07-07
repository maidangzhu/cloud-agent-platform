"use client";

import {
  AlertCircleIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  FileTextIcon,
  LinkIcon,
  Loader2Icon,
  PackageIcon,
  SparklesIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ArtifactPreview } from "./artifact-preview";
import type { ArtifactKind, UIArtifact } from "@/hooks/use-artifact";
import { cn } from "@/lib/utils";

export type RunEventType =
  | "run_created"
  | "sandbox_provisioning"
  | "sandbox_ready"
  | "runner_started"
  | "agent_started"
  | "agent_thinking"
  | "agent_message"
  | "tool_call_started"
  | "tool_call_completed"
  | "tool_call_failed"
  | "file_written"
  | "source_recorded"
  | "artifact_started"
  | "artifact_delta"
  | "artifact_created"
  | "artifact_updated"
  | "artifact_failed"
  | "run_completed"
  | "run_failed"
  | "run_timeout"
  | "run_cancelled"
  | "run_waiting_for_input";

export type RunEventDTO = {
  seq: number;
  type: RunEventType | string;
  role?: string;
  title?: string;
  content?: string;
  payload: unknown;
  createdAt: string;
};

export type StreamChunkDTO = {
  runId: string;
  streamType: "thinking" | "content";
  chunk: string;
};

export function RunEventList({
  events,
  streamChunks = [],
  isLoading = false,
}: {
  events: RunEventDTO[];
  streamChunks?: StreamChunkDTO[];
  isLoading?: boolean;
}) {
  const hasStreamChunks = streamChunks.length > 0;

  if (isLoading) {
    return (
      <div className="message-fade-in flex items-center gap-2 rounded-2xl border border-border/50 bg-card px-4 py-3 text-[13px] text-muted-foreground shadow-[var(--shadow-card)]">
        <Loader2Icon className="size-4 animate-spin" />
        Loading run events
      </div>
    );
  }

  if (events.length === 0 && !hasStreamChunks) {
    return (
      <div className="message-fade-in rounded-2xl border border-border/50 bg-card px-4 py-3 text-[13px] leading-6 text-muted-foreground shadow-[var(--shadow-card)]">
        Run events will appear here after a run starts.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {hasStreamChunks && <StreamChunkGroup chunks={streamChunks} />}
      {events.map((event) => (
        <RunEventRenderer event={event} key={`${event.seq}-${event.type}`} />
      ))}
    </div>
  );
}

export function RunEventRenderer({ event }: { event: RunEventDTO }) {
  if (event.type === "agent_thinking") {
    return (
      <AssistantRow>
        <RunReasoning
          isStreaming={false}
          reasoning={event.content || "Reasoning was recorded."}
        />
      </AssistantRow>
    );
  }

  if (event.type === "agent_message") {
    return (
      <AssistantRow>
        <MessageContent>{event.content || "Message content is empty."}</MessageContent>
      </AssistantRow>
    );
  }

  if (
    event.type === "tool_call_started" ||
    event.type === "tool_call_completed" ||
    event.type === "tool_call_failed"
  ) {
    return (
      <AssistantRow>
        <ToolCallRenderer event={event} />
      </AssistantRow>
    );
  }

  if (
    event.type === "artifact_started" ||
    event.type === "artifact_delta" ||
    event.type === "artifact_created" ||
    event.type === "artifact_updated" ||
    event.type === "artifact_failed"
  ) {
    return (
      <AssistantRow>
        <RunFactEvent event={event} />
      </AssistantRow>
    );
  }

  if (event.type === "file_written" || event.type === "source_recorded") {
    return (
      <AssistantRow>
        <RunFactEvent event={event} />
      </AssistantRow>
    );
  }

  return (
    <AssistantRow>
      <RunStatusEvent event={event} />
    </AssistantRow>
  );
}

function StreamChunkGroup({ chunks }: { chunks: StreamChunkDTO[] }) {
  const thinking = chunks
    .filter((chunk) => chunk.streamType === "thinking")
    .map((chunk) => chunk.chunk)
    .join("");
  const content = chunks
    .filter((chunk) => chunk.streamType === "content")
    .map((chunk) => chunk.chunk)
    .join("");

  return (
    <>
      {thinking && (
        <AssistantRow>
          <RunReasoning isStreaming={true} reasoning={thinking} />
        </AssistantRow>
      )}
      {content && (
        <AssistantRow>
          <MessageContent>{content}</MessageContent>
        </AssistantRow>
      )}
    </>
  );
}

function AssistantRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="message-fade-in flex items-start gap-3">
      <div className="flex h-[calc(13px*1.65)] shrink-0 items-center">
        <div className="flex size-7 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground ring-1 ring-border/50">
          <SparklesIcon size={13} />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">{children}</div>
    </div>
  );
}

function MessageContent({ children }: { children: string }) {
  return (
    <div className="flex min-w-0 max-w-full flex-col gap-2 overflow-hidden text-[13px] leading-[1.65] text-foreground">
      <p className="whitespace-pre-wrap break-words">{children}</p>
    </div>
  );
}

function RunReasoning({
  reasoning,
  isStreaming,
}: {
  reasoning: string;
  isStreaming: boolean;
}) {
  const [open, setOpen] = useState(isStreaming);
  const [duration, setDuration] = useState<number | undefined>(undefined);
  const startRef = useRef<number | null>(isStreaming ? Date.now() : null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isStreaming) {
      setOpen(true);
      if (startRef.current === null) {
        startRef.current = Date.now();
      }
    } else if (startRef.current !== null) {
      setDuration(Math.ceil((Date.now() - startRef.current) / 1000));
      startRef.current = null;
    }
  }, [isStreaming]);

  useEffect(() => {
    if (isStreaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [reasoning, isStreaming]);

  return (
    <Collapsible className="not-prose" onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 text-[13px] leading-[1.65] text-muted-foreground transition-colors hover:text-foreground">
        {isStreaming || duration === 0 ? (
          <span className="font-medium">Thinking...</span>
        ) : duration === undefined ? (
          <span>Thought for a few seconds</span>
        ) : (
          <span>Thought for {duration} seconds</span>
        )}
        <ChevronDownIcon
          className={cn("size-4 transition-transform", open && "rotate-180")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 animate-in fade-in-0 text-muted-foreground/60 duration-200 [overflow-anchor:none]">
          <div
            className="max-h-[200px] overflow-y-auto rounded-lg border border-border/20 bg-muted/30 px-3 py-2 text-[11px] leading-relaxed"
            ref={scrollRef}
            style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
          >
            <p className="whitespace-pre-wrap break-words">{reasoning}</p>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolCallRenderer({ event }: { event: RunEventDTO }) {
  const payload = asRecord(event.payload);
  const name = getString(payload.name) ?? event.title ?? "tool";
  const state = toolState(event.type);
  const result = payload.result;
  const error = getString(payload.error);
  const args = payload.args;

  return (
    <Collapsible
      className="group not-prose mb-4 w-[min(100%,450px)] rounded-md border bg-card"
      defaultOpen={event.type !== "tool_call_completed"}
    >
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-4 p-3">
        <div className="flex min-w-0 items-center gap-2">
          <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{name}</span>
          <ToolStatusBadge state={state} />
        </div>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 p-4 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:animate-in data-[state=open]:slide-in-from-top-2">
        {args !== undefined && (
          <JsonBlock label="Parameters" value={args} />
        )}
        {result !== undefined && <JsonBlock label="Result" value={result} />}
        {error && (
          <div className="space-y-2">
            <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              Error
            </h4>
            <div className="overflow-x-auto rounded-md bg-destructive/10 p-3 text-xs text-destructive">
              {error}
            </div>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolStatusBadge({
  state,
}: {
  state: "running" | "completed" | "failed";
}) {
  const icon =
    state === "running" ? (
      <ClockIcon className="size-4 animate-pulse" />
    ) : state === "completed" ? (
      <CheckCircleIcon className="size-4 text-green-600" />
    ) : (
      <XCircleIcon className="size-4 text-red-600" />
    );
  const label =
    state === "running" ? "Running" : state === "completed" ? "Completed" : "Error";

  return (
    <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
      {icon}
      {label}
    </Badge>
  );
}

function RunFactEvent({ event }: { event: RunEventDTO }) {
  if (
    event.type === "artifact_started" ||
    event.type === "artifact_delta" ||
    event.type === "artifact_created" ||
    event.type === "artifact_updated" ||
    event.type === "artifact_failed"
  ) {
    return <ArtifactEventPreview event={event} />;
  }

  const payload = asRecord(event.payload);
  const config = factConfig(event.type);
  const title =
    event.title ??
    getString(payload.title) ??
    getString(payload.path) ??
    getString(payload.uri) ??
    config.title;

  return (
    <div className="w-[min(100%,450px)] rounded-xl border border-border/50 bg-card px-3 py-2 text-[13px] shadow-[var(--shadow-card)]">
      <div className="flex min-w-0 items-center gap-2">
        <config.icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium">{title}</span>
        <Badge className="ml-auto rounded-full text-xs" variant="secondary">
          {config.badge}
        </Badge>
      </div>
      <div className="mt-2 text-xs text-muted-foreground">
        {config.description}
      </div>
    </div>
  );
}

function ArtifactEventPreview({ event }: { event: RunEventDTO }) {
  const payload = asRecord(event.payload);
  const title =
    event.title ??
    getString(payload.title) ??
    getString(payload.path) ??
    "Research artifact";
  const content =
    event.content ??
    getString(payload.content) ??
    getString(payload.markdown) ??
    getString(payload.text) ??
    getString(payload.deltaText) ??
    getString(payload.delta) ??
    "";
  const status: UIArtifact["status"] =
    event.type === "artifact_failed"
      ? "failed"
      : event.type === "artifact_started" || event.type === "artifact_delta"
        ? "streaming"
        : "idle";

  return (
    <ArtifactPreview
      artifact={{
        id: getString(payload.id) ?? getString(payload.artifactId) ?? undefined,
        title,
        kind: normalizeArtifactKind(payload.kind),
        content,
        status,
      }}
    />
  );
}

function RunStatusEvent({ event }: { event: RunEventDTO }) {
  const config = statusConfig(event.type);
  return (
    <div className="flex w-fit max-w-[min(100%,450px)] items-center gap-2 rounded-xl border border-border/50 bg-card px-3 py-2 text-[13px] text-muted-foreground shadow-[var(--shadow-card)]">
      <config.icon className={cn("size-4 shrink-0", config.spin && "animate-spin")} />
      <span>{event.title ?? config.label}</span>
    </div>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="space-y-2 overflow-hidden">
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </h4>
      <pre className="overflow-x-auto rounded-md bg-muted/50 p-3 text-xs leading-relaxed">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function toolState(type: string): "running" | "completed" | "failed" {
  if (type === "tool_call_completed") return "completed";
  if (type === "tool_call_failed") return "failed";
  return "running";
}

function factConfig(type: string) {
  if (type === "file_written") {
    return {
      title: "File written",
      badge: "file",
      description: "The run wrote a workspace file.",
      icon: FileTextIcon,
    };
  }
  if (type === "source_recorded") {
    return {
      title: "Source recorded",
      badge: "source",
      description: "The run attached a source for later citation.",
      icon: LinkIcon,
    };
  }
  if (type === "artifact_failed") {
    return {
      title: "Artifact failed",
      badge: "error",
      description: "Artifact generation failed.",
      icon: AlertCircleIcon,
    };
  }
  return {
    title: "Artifact updated",
    badge: "artifact",
    description: "The run changed an artifact snapshot.",
    icon: PackageIcon,
  };
}

function statusConfig(type: string) {
  if (type === "run_completed") {
    return { label: "Run completed", icon: CheckCircleIcon, spin: false };
  }
  if (type === "run_failed" || type === "run_timeout") {
    return { label: "Run failed", icon: XCircleIcon, spin: false };
  }
  if (type === "run_waiting_for_input") {
    return { label: "Waiting for input", icon: ClockIcon, spin: false };
  }
  if (type === "run_cancelled") {
    return { label: "Run cancelled", icon: CircleIcon, spin: false };
  }
  return {
    label: humanizeEventType(type),
    icon: Loader2Icon,
    spin:
      type === "sandbox_provisioning" ||
      type === "runner_started" ||
      type === "agent_started",
  };
}

function humanizeEventType(type: string) {
  return type.replaceAll("_", " ");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeArtifactKind(value: unknown): ArtifactKind {
  return value === "code" || value === "image" || value === "sheet"
    ? value
    : "text";
}

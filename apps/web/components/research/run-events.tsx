"use client";

import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleIcon,
  Clock3Icon,
  FileTextIcon,
  LinkIcon,
  Loader2Icon,
  PackageIcon,
  SparklesIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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

const TERMINAL_EVENTS = new Set([
  "run_completed",
  "run_failed",
  "run_timeout",
  "run_cancelled",
  "run_waiting_for_input",
]);

export function RunEventList({
  events,
  streamChunks = [],
  isLoading = false,
}: {
  events: RunEventDTO[];
  streamChunks?: StreamChunkDTO[];
  isLoading?: boolean;
}) {
  const streamThinking = joinChunks(streamChunks, "thinking");
  const streamContent = joinChunks(streamChunks, "content");
  const recordedThinking = joinEventContent(events, "agent_thinking");
  const recordedContent = joinEventContent(events, "agent_message");
  const thinking = streamThinking || recordedThinking;
  const content = streamContent || recordedContent;
  const isActive = !events.some((event) => TERMINAL_EVENTS.has(event.type));
  const activityEvents = useMemo(() => compactActivityEvents(events), [events]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
        Loading run
      </div>
    );
  }

  if (!thinking && !content && activityEvents.length === 0) {
    return null;
  }

  return (
    <div className="message-fade-in flex items-start gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <SparklesIcon className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        {thinking && (
          <RunReasoning
            isStreaming={Boolean(streamThinking) && isActive}
            reasoning={thinking}
          />
        )}
        {content && <AssistantMessage content={content} />}
        {!content && isActive && (
          <div className="flex items-center gap-2 py-0.5 text-[13px] text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            Working
          </div>
        )}
        {activityEvents.length > 0 && (
          <RunActivity events={activityEvents} isActive={isActive} />
        )}
      </div>
    </div>
  );
}

function AssistantMessage({ content }: { content: string }) {
  return (
    <div className="prose prose-sm max-w-[72ch] break-words text-foreground prose-headings:font-semibold prose-headings:tracking-normal prose-p:my-3 prose-p:leading-6 prose-a:text-primary prose-pre:overflow-x-auto prose-pre:rounded-md prose-pre:border prose-pre:border-border prose-pre:bg-muted prose-code:break-words dark:prose-invert">
      <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
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
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isStreaming) setOpen(true);
  }, [isStreaming]);

  useEffect(() => {
    if (isStreaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [reasoning, isStreaming]);

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground">
        {isStreaming ? "Thinking" : "Reasoning"}
        {isStreaming && <Loader2Icon className="size-3 animate-spin" />}
        <ChevronDownIcon
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          className="mt-2 max-h-40 overflow-y-auto border-l-2 border-border pl-3 text-[12px] leading-5 text-muted-foreground"
          ref={scrollRef}
        >
          <p className="whitespace-pre-wrap break-words">{reasoning}</p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function RunActivity({
  events,
  isActive,
}: {
  events: RunEventDTO[];
  isActive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const toolCount = events.filter((event) => event.type.startsWith("tool_call_"))
    .length;
  const failed = events.some((event) =>
    ["run_failed", "run_timeout", "tool_call_failed", "artifact_failed"].includes(
      event.type
    )
  );

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger
        className="group flex min-h-8 items-center gap-2 rounded-md px-2 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        data-testid="run-activity-toggle"
      >
        {isActive ? (
          <Loader2Icon className="size-3.5 animate-spin" />
        ) : failed ? (
          <AlertCircleIcon className="size-3.5 text-destructive" />
        ) : (
          <CheckCircle2Icon className="size-3.5 text-primary" />
        )}
        <span>{activityLabel(events, isActive, toolCount)}</span>
        <ChevronDownIcon
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 max-w-2xl overflow-hidden rounded-md border border-border bg-card">
          {events.map((event) => (
            <ActivityEvent event={event} key={`${event.seq}-${event.type}`} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ActivityEvent({ event }: { event: RunEventDTO }) {
  if (event.type.startsWith("tool_call_")) {
    return <ToolActivity event={event} />;
  }

  const config = activityConfig(event.type);
  const payload = asRecord(event.payload);
  const title =
    event.title ??
    getString(payload.title) ??
    getString(payload.path) ??
    getString(payload.uri) ??
    config.label;

  return (
    <div
      className="flex min-h-9 items-center gap-2 border-b border-border/70 px-3 text-[12px] text-muted-foreground last:border-b-0"
      data-event-type={event.type}
      data-testid="run-status-event"
    >
      <config.icon
        className={cn(
          "size-3.5 shrink-0",
          config.spin && "animate-spin",
          config.tone
        )}
      />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground/60">
        {formatTime(event.createdAt)}
      </span>
    </div>
  );
}

function ToolActivity({ event }: { event: RunEventDTO }) {
  const payload = asRecord(event.payload);
  const name = getString(payload.name) ?? event.title ?? "Tool";
  const state = toolState(event.type);
  const args = payload.args;
  const result = payload.result;
  const error = getString(payload.error);

  return (
    <Collapsible
      className="group border-b border-border/70 last:border-b-0"
      data-testid="tool-call"
      data-tool-name={name}
      data-tool-status={state}
    >
      <CollapsibleTrigger className="flex min-h-9 w-full items-center gap-2 px-3 text-left text-[12px] text-muted-foreground hover:bg-muted/60">
        <WrenchIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span className={cn("text-[11px]", state === "failed" && "text-destructive")}>
          {state}
        </span>
        <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-3 border-t border-border/70 bg-muted/30 px-3 py-3">
          {args !== undefined && <JsonBlock label="Parameters" value={args} />}
          {result !== undefined && <JsonBlock label="Result" value={result} />}
          {error && <JsonBlock label="Error" value={error} />}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="space-y-1.5 overflow-hidden">
      <div className="text-[10px] font-medium uppercase text-muted-foreground">
        {label}
      </div>
      <pre className="overflow-x-auto rounded-md bg-background p-2 text-[11px] leading-5 text-foreground">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function compactActivityEvents(events: RunEventDTO[]) {
  const operational = events.filter(
    (event) =>
      event.type !== "agent_thinking" &&
      event.type !== "agent_message" &&
      event.type !== "artifact_delta"
  );
  const latestToolEvent = new Map<string, RunEventDTO>();

  for (const event of operational) {
    if (!event.type.startsWith("tool_call_")) continue;
    const payload = asRecord(event.payload);
    const key =
      getString(payload.toolCallId) ??
      getString(payload.callId) ??
      getString(payload.id) ??
      getString(payload.name) ??
      `tool-${event.seq}`;
    latestToolEvent.set(key, event);
  }

  return operational.filter((event) => {
    if (!event.type.startsWith("tool_call_")) return true;
    return [...latestToolEvent.values()].includes(event);
  });
}

function activityLabel(
  events: RunEventDTO[],
  isActive: boolean,
  toolCount: number
) {
  const toolsLabel = `${toolCount} ${toolCount === 1 ? "tool" : "tools"}`;
  if (isActive) return toolCount ? `Working - ${toolsLabel}` : "Working";
  if (events.some((event) => event.type === "run_waiting_for_input")) {
    return "Waiting for input";
  }
  if (events.some((event) => event.type === "run_cancelled")) return "Cancelled";
  if (events.some((event) => event.type === "run_failed" || event.type === "run_timeout")) {
    return "Run failed";
  }
  return toolCount ? `Completed - ${toolsLabel}` : "Completed";
}

function activityConfig(type: string) {
  if (type === "run_completed") {
    return { label: "Completed", icon: CheckCircle2Icon, spin: false, tone: "text-primary" };
  }
  if (type === "run_failed" || type === "run_timeout" || type === "artifact_failed") {
    return { label: "Failed", icon: XCircleIcon, spin: false, tone: "text-destructive" };
  }
  if (type === "run_waiting_for_input") {
    return { label: "Waiting for input", icon: Clock3Icon, spin: false, tone: "" };
  }
  if (type === "run_cancelled") {
    return { label: "Cancelled", icon: CircleIcon, spin: false, tone: "" };
  }
  if (type === "file_written") {
    return { label: "File written", icon: FileTextIcon, spin: false, tone: "" };
  }
  if (type === "source_recorded") {
    return { label: "Source recorded", icon: LinkIcon, spin: false, tone: "" };
  }
  if (type.startsWith("artifact_")) {
    return { label: "Artifact updated", icon: PackageIcon, spin: false, tone: "" };
  }
  const spin = ["sandbox_provisioning", "runner_started", "agent_started"].includes(type);
  return {
    label: humanizeEventType(type),
    icon: spin ? Loader2Icon : CheckCircle2Icon,
    spin,
    tone: "",
  };
}

function joinChunks(chunks: StreamChunkDTO[], type: StreamChunkDTO["streamType"]) {
  return chunks
    .filter((chunk) => chunk.streamType === type)
    .map((chunk) => chunk.chunk)
    .join("");
}

function joinEventContent(events: RunEventDTO[], type: string) {
  return events
    .filter((event) => event.type === type && event.content)
    .map((event) => event.content)
    .join("\n\n");
}

function toolState(type: string): "running" | "completed" | "failed" {
  if (type === "tool_call_completed") return "completed";
  if (type === "tool_call_failed") return "failed";
  return "running";
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(date);
}

function humanizeEventType(type: string) {
  const label = type.replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

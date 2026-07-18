"use client";

import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleIcon,
  Clock3Icon,
  FileTextIcon,
  LinkIcon,
  ListTreeIcon,
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
import {
  selectRunContent,
  selectRunPhase,
  selectRunThinking,
  type ChatRunState,
  type RunEventDTO,
  type RunEventType,
  type SseConnection,
  type StreamChunkDTO,
} from "@/lib/chat-runtime";
import { cn } from "@/lib/utils";

export type { RunEventDTO, RunEventType, StreamChunkDTO } from "@/lib/chat-runtime";

export function RunEventList({
  connection = "closed",
  error = "",
  fallbackContent = "",
  isCurrent = false,
  view,
}: {
  connection?: SseConnection;
  error?: string;
  fallbackContent?: string;
  isCurrent?: boolean;
  view: ChatRunState;
}) {
  const phase = selectRunPhase(view);
  const thinking = selectRunThinking(view);
  const content = selectRunContent(view) || fallbackContent;
  const activityEvents = useMemo(
    () => compactActivityEvents(view.events),
    [view.events]
  );
  const connectionHint =
    isCurrent && phase.active && connection === "retrying"
      ? "Reconnecting to live updates"
      : "";

  return (
    <div className="message-fade-in flex items-start gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <SparklesIcon className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        <RunStatusRow phase={phase} />

        {connectionHint && (
          <div className="text-[12px] text-muted-foreground">{connectionHint}</div>
        )}

        {thinking && (
          <RunReasoning isThinking={phase.key === "thinking"} reasoning={thinking} />
        )}

        {content && <AssistantMessage content={content} />}

        {view.run.status === "waiting_for_input" && view.run.waitingForInput && (
          <div className="max-w-xl border-l-2 border-border px-3 py-1 text-[13px] leading-6">
            <div className="font-medium">{view.run.waitingForInput.question}</div>
            {view.run.waitingForInput.options?.length ? (
              <div className="mt-1 text-muted-foreground">
                {view.run.waitingForInput.options.join(" / ")}
              </div>
            ) : null}
          </div>
        )}

        {(view.run.error || (error && connection !== "retrying")) && (
          <div className="max-w-xl border-l-2 border-destructive px-3 py-1 text-[12px] leading-5 text-destructive">
            {formatRunError(view.run.error || error)}
          </div>
        )}

        {activityEvents.length > 0 && <RunActivity events={activityEvents} />}
      </div>
    </div>
  );
}

function RunStatusRow({ phase }: { phase: ReturnType<typeof selectRunPhase> }) {
  const Icon = phase.active
    ? Loader2Icon
    : phase.tone === "success"
      ? CheckCircle2Icon
      : phase.tone === "danger"
        ? AlertCircleIcon
        : phase.key === "waiting"
          ? Clock3Icon
          : CircleIcon;

  return (
    <div
      className={cn(
        "flex min-h-6 items-center gap-2 text-[13px]",
        phase.tone === "danger" ? "text-destructive" : "text-muted-foreground"
      )}
      data-run-phase={phase.key}
      data-testid="run-phase"
    >
      <Icon className={cn("size-3.5 shrink-0", phase.active && "animate-spin")} />
      <span>{phase.label}</span>
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
  isThinking,
}: {
  reasoning: string;
  isThinking: boolean;
}) {
  const [open, setOpen] = useState(isThinking);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isThinking) setOpen(true);
  }, [isThinking]);

  useEffect(() => {
    if (isThinking && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [reasoning, isThinking]);

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground">
        Reasoning
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

function RunActivity({ events }: { events: RunEventDTO[] }) {
  const [open, setOpen] = useState(false);
  const toolCount = events.filter((event) => event.type.startsWith("tool_call_")).length;
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
        {failed ? (
          <AlertCircleIcon className="size-3.5 text-destructive" />
        ) : (
          <ListTreeIcon className="size-3.5" />
        )}
        <span>
          Activity{toolCount ? ` · ${toolCount} ${toolCount === 1 ? "tool" : "tools"}` : ""}
        </span>
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
  if (event.type.startsWith("tool_call_")) return <ToolActivity event={event} />;

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
      <config.icon className={cn("size-3.5 shrink-0", config.tone)} />
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
    latestToolEvent.set(toolEventKey(event), event);
  }

  return operational.filter(
    (event) =>
      !event.type.startsWith("tool_call_") || latestToolEvent.get(toolEventKey(event)) === event
  );
}

function toolEventKey(event: RunEventDTO) {
  const payload = asRecord(event.payload);
  return (
    getString(payload.toolCallId) ??
    getString(payload.callId) ??
    getString(payload.id) ??
    getString(payload.name) ??
    `tool-${event.seq}`
  );
}

function activityConfig(type: string) {
  if (type === "run_completed") {
    return { label: "Completed", icon: CheckCircle2Icon, tone: "text-primary" };
  }
  if (type === "run_failed" || type === "run_timeout" || type === "artifact_failed") {
    return { label: "Failed", icon: XCircleIcon, tone: "text-destructive" };
  }
  if (type === "run_waiting_for_input") {
    return { label: "Waiting for input", icon: Clock3Icon, tone: "" };
  }
  if (type === "run_cancelled") {
    return { label: "Cancelled", icon: CircleIcon, tone: "" };
  }
  if (type === "file_written") {
    return { label: "File written", icon: FileTextIcon, tone: "" };
  }
  if (type === "source_recorded") {
    return { label: "Source recorded", icon: LinkIcon, tone: "" };
  }
  if (type.startsWith("artifact_")) {
    return { label: "Artifact updated", icon: PackageIcon, tone: "" };
  }
  return { label: humanizeEventType(type), icon: CheckCircle2Icon, tone: "" };
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
  return typeof value === "string" && value.trim() ? value : undefined;
}

function formatRunError(value: string) {
  return value
    .replace(/^Error:\s*/, "")
    .replace(/^[A-Z][A-Z0-9_]+:/, "")
    .split(/\n|\s+at\s+(?=[\w./(])/)[0]
    .trim();
}

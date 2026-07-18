import type {
  AgentRun,
  RunArtifact,
  RunSource,
  RunStatus,
  RunUsageRecord,
  ThreadMessage,
} from "@/components/research/types";

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

export type ClientStreamChunk = StreamChunkDTO & { id: string };
export type ThreadRun = AgentRun & { events: RunEventDTO[] };
export type ThreadPhase = "idle" | "loading" | "ready" | "error";
export type SseConnection =
  | "idle"
  | "connecting"
  | "open"
  | "retrying"
  | "closed";

export type ChatRunState = {
  run: AgentRun;
  events: RunEventDTO[];
  chunks: ClientStreamChunk[];
  artifacts: RunArtifact[];
  sources: RunSource[];
  usage: RunUsageRecord[];
};

export type ChatState = {
  threadId: string | null;
  phase: ThreadPhase;
  messages: ThreadMessage[];
  runs: Record<string, ChatRunState>;
  runOrder: string[];
  activeRunId: string | null;
  connection: SseConnection;
  error: string;
  isStarting: boolean;
  isCancelling: boolean;
};

export const initialChatState: ChatState = {
  threadId: null,
  phase: "idle",
  messages: [],
  runs: {},
  runOrder: [],
  activeRunId: null,
  connection: "idle",
  error: "",
  isStarting: false,
  isCancelling: false,
};

export type ChatAction =
  | { type: "thread/cleared" }
  | { type: "thread/loading"; threadId: string }
  | {
      type: "thread/loaded";
      threadId: string;
      messages: ThreadMessage[];
      runs: ThreadRun[];
    }
  | { type: "thread/failed"; threadId: string; error: string }
  | { type: "run/starting" }
  | { type: "run/created"; run: AgentRun }
  | { type: "run/start_failed"; error: string }
  | {
      type: "run/detail_loaded";
      threadId: string;
      run: AgentRun;
      events: RunEventDTO[];
      artifacts: RunArtifact[];
      sources: RunSource[];
      usage: RunUsageRecord[];
    }
  | { type: "run/detail_failed"; threadId: string; error: string }
  | { type: "sse/connecting"; runId: string }
  | { type: "sse/open"; runId: string }
  | {
      type: "sse/snapshot";
      runId: string;
      run: AgentRun;
      events: RunEventDTO[];
    }
  | { type: "sse/chunk"; runId: string; chunk: ClientStreamChunk }
  | { type: "sse/event"; runId: string; event: RunEventDTO }
  | { type: "sse/done"; runId: string; status: RunStatus }
  | { type: "sse/error"; runId: string; error: string }
  | { type: "run/cancelling" }
  | { type: "run/cancelled"; run: AgentRun }
  | { type: "run/cancel_failed"; error: string };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "thread/cleared":
      return initialChatState;
    case "thread/loading":
      return {
        ...initialChatState,
        threadId: action.threadId,
        phase: "loading",
      };
    case "thread/loaded": {
      if (state.threadId !== action.threadId) return state;
      const incomingRuns = Object.fromEntries(
        action.runs.map((run) => [run.id, createRunState(run, run.events)])
      );
      const runs = mergeRunStateMaps(incomingRuns, state.runs);
      const runOrder = sortRunIds(runs);
      return {
        ...state,
        phase: "ready",
        messages: mergeMessages(action.messages, state.messages),
        runs,
        runOrder,
        activeRunId: latestRunId(runs),
        error: "",
      };
    }
    case "thread/failed":
      if (state.threadId !== action.threadId) return state;
      return { ...state, phase: "error", error: action.error };
    case "run/starting":
      return { ...state, isStarting: true, error: "" };
    case "run/created": {
      if (state.threadId !== action.run.threadId) return state;
      const runs = {
        ...state.runs,
        [action.run.id]: createRunState(action.run),
      };
      return {
        ...state,
        phase: "ready",
        runs,
        runOrder: sortRunIds(runs),
        activeRunId: action.run.id,
        connection: "idle",
        isStarting: false,
        error: "",
      };
    }
    case "run/start_failed":
      return { ...state, isStarting: false, error: action.error };
    case "run/detail_loaded": {
      if (state.threadId !== action.threadId) return state;
      const current = state.runs[action.run.id];
      const nextRun: ChatRunState = {
        run: action.run,
        events: mergeRunEvents(current?.events ?? [], action.events),
        chunks: current?.chunks ?? [],
        artifacts: action.artifacts,
        sources: action.sources,
        usage: action.usage,
      };
      const runs = { ...state.runs, [action.run.id]: nextRun };
      return {
        ...state,
        runs,
        runOrder: sortRunIds(runs),
        activeRunId: latestRunId(runs),
        error: "",
      };
    }
    case "run/detail_failed":
      if (state.threadId !== action.threadId) return state;
      return { ...state, error: action.error };
    case "sse/connecting":
      return isCurrentRun(state, action.runId)
        ? { ...state, connection: "connecting" }
        : state;
    case "sse/open":
      return isCurrentRun(state, action.runId)
        ? { ...state, connection: "open", error: "" }
        : state;
    case "sse/snapshot":
      return updateRun(state, action.runId, (current) => ({
        ...current,
        run: action.run,
        events: mergeRunEvents(current.events, action.events),
      }));
    case "sse/chunk":
      return updateRun(state, action.runId, (current) => ({
        ...current,
        chunks: current.chunks.some((chunk) => chunk.id === action.chunk.id)
          ? current.chunks
          : [...current.chunks, action.chunk],
      }));
    case "sse/event":
      return updateRun(state, action.runId, (current) => ({
        ...current,
        events: mergeRunEvents(current.events, [action.event]),
      }));
    case "sse/done": {
      const next = updateRun(state, action.runId, (current) => ({
        ...current,
        run: { ...current.run, status: action.status },
      }));
      return isCurrentRun(next, action.runId)
        ? { ...next, connection: "closed", isCancelling: false }
        : next;
    }
    case "sse/error":
      return isCurrentRun(state, action.runId)
        ? { ...state, connection: "retrying", error: action.error }
        : state;
    case "run/cancelling":
      return { ...state, isCancelling: true, error: "" };
    case "run/cancelled": {
      const next = updateRun(state, action.run.id, (current) => ({
        ...current,
        run: action.run,
      }));
      return { ...next, isCancelling: false };
    }
    case "run/cancel_failed":
      return { ...state, isCancelling: false, error: action.error };
  }
}

export type VisibleRunPhase = {
  key:
    | "preparing"
    | "starting"
    | "thinking"
    | "tool"
    | "writing"
    | "waiting"
    | "stopping"
    | "completed"
    | "failed"
    | "cancelled"
    | "timeout";
  label: string;
  active: boolean;
  tone: "default" | "success" | "danger";
};

export function selectActiveRun(state: ChatState) {
  return state.activeRunId ? state.runs[state.activeRunId] ?? null : null;
}

export function selectRunPhase(view: ChatRunState): VisibleRunPhase {
  const { status } = view.run;
  if (status === "completed") return phase("completed", "Completed", false, "success");
  if (status === "failed" || status === "interrupted") {
    return phase("failed", "Failed", false, "danger");
  }
  if (status === "timeout") return phase("timeout", "Timed out", false, "danger");
  if (status === "cancelled") return phase("cancelled", "Cancelled", false, "default");
  if (status === "waiting_for_input") {
    return phase("waiting", "Waiting for input", false, "default");
  }
  if (status === "cancel_requested") {
    return phase("stopping", "Stopping", true, "default");
  }

  const runningTool = findRunningTool(view.events);
  if (runningTool) {
    return phase("tool", `Running ${runningTool}`, true, "default");
  }
  if (
    view.chunks.some((chunk) => chunk.streamType === "content") ||
    hasEvent(view.events, "agent_message") ||
    hasEvent(view.events, "artifact_delta")
  ) {
    return phase("writing", "Writing response", true, "default");
  }
  if (
    view.chunks.some((chunk) => chunk.streamType === "thinking") ||
    hasEvent(view.events, "agent_thinking")
  ) {
    return phase("thinking", "Thinking", true, "default");
  }
  if (
    hasEvent(view.events, "sandbox_ready") ||
    hasEvent(view.events, "runner_started") ||
    hasEvent(view.events, "agent_started")
  ) {
    return phase("starting", "Starting agent", true, "default");
  }
  return phase("preparing", "Preparing sandbox", true, "default");
}

export function selectRunContent(view: ChatRunState) {
  return selectStreamOrEventContent(view, "content", "agent_message");
}

export function selectRunThinking(view: ChatRunState) {
  return selectStreamOrEventContent(view, "thinking", "agent_thinking");
}

export function selectIsRunActive(run: AgentRun | null | undefined) {
  return Boolean(
    run &&
      ["created", "provisioning_sandbox", "running", "cancel_requested"].includes(
        run.status
      )
  );
}

export function mergeRunEvents(current: RunEventDTO[], incoming: RunEventDTO[]) {
  const bySeq = new Map<number, RunEventDTO>();
  for (const event of current) bySeq.set(event.seq, event);
  for (const event of incoming) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

function createRunState(run: AgentRun, events: RunEventDTO[] = []): ChatRunState {
  return { run, events, chunks: [], artifacts: [], sources: [], usage: [] };
}

function mergeRunStateMaps(
  incoming: Record<string, ChatRunState>,
  current: Record<string, ChatRunState>
) {
  const merged = { ...incoming };
  for (const [runId, currentRun] of Object.entries(current)) {
    const incomingRun = merged[runId];
    merged[runId] = incomingRun
      ? {
          ...incomingRun,
          run:
            incomingRun.run.updatedAt >= currentRun.run.updatedAt
              ? incomingRun.run
              : currentRun.run,
          events: mergeRunEvents(incomingRun.events, currentRun.events),
          chunks: currentRun.chunks,
          artifacts: currentRun.artifacts,
          sources: currentRun.sources,
          usage: currentRun.usage,
        }
      : currentRun;
  }
  return merged;
}

function updateRun(
  state: ChatState,
  runId: string,
  updater: (current: ChatRunState) => ChatRunState
) {
  const current = state.runs[runId];
  if (!current) return state;
  return { ...state, runs: { ...state.runs, [runId]: updater(current) } };
}

function isCurrentRun(state: ChatState, runId: string) {
  return state.activeRunId === runId;
}

function sortRunIds(runs: Record<string, ChatRunState>) {
  return Object.values(runs)
    .sort((left, right) => left.run.createdAt.localeCompare(right.run.createdAt))
    .map((item) => item.run.id);
}

function latestRunId(runs: Record<string, ChatRunState>) {
  return sortRunIds(runs).at(-1) ?? null;
}

function mergeMessages(incoming: ThreadMessage[], current: ThreadMessage[]) {
  const messages = new Map<string, ThreadMessage>();
  for (const message of current) messages.set(message.id, message);
  for (const message of incoming) messages.set(message.id, message);
  return [...messages.values()].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)
  );
}

function phase(
  key: VisibleRunPhase["key"],
  label: string,
  active: boolean,
  tone: VisibleRunPhase["tone"]
): VisibleRunPhase {
  return { key, label, active, tone };
}

function hasEvent(events: RunEventDTO[], type: RunEventType) {
  return events.some((event) => event.type === type);
}

function findRunningTool(events: RunEventDTO[]) {
  const active = new Map<string, string>();
  for (const event of events) {
    if (!event.type.startsWith("tool_call_")) continue;
    const payload = asRecord(event.payload);
    const name = getString(payload.name) ?? event.title ?? "tool";
    const id =
      getString(payload.toolCallId) ??
      getString(payload.callId) ??
      getString(payload.id) ??
      name;
    if (event.type === "tool_call_started") active.set(id, name);
    if (event.type === "tool_call_completed" || event.type === "tool_call_failed") {
      active.delete(id);
    }
  }
  return [...active.values()].at(-1) ?? null;
}

function selectStreamOrEventContent(
  view: ChatRunState,
  streamType: StreamChunkDTO["streamType"],
  eventType: RunEventType
) {
  const streamed = view.chunks
    .filter((chunk) => chunk.streamType === streamType)
    .map((chunk) => chunk.chunk)
    .join("");
  if (streamed) return streamed;
  return view.events
    .filter((event) => event.type === eventType && event.content)
    .map((event) => event.content)
    .join("\n\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

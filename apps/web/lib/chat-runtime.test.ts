import { describe, expect, it } from "vitest";
import type { AgentRun } from "@/components/research/types";
import {
  chatReducer,
  initialChatState,
  selectRunContent,
  selectRunPhase,
  type ChatState,
  type ChatRunState,
  type RunEventDTO,
} from "./chat-runtime";

describe("chat runtime", () => {
  it("keeps live chunks when an SSE snapshot is replayed", () => {
    const run = makeRun();
    let state = chatReducer(initialChatState, {
      type: "thread/loading",
      threadId: run.threadId,
    });
    state = chatReducer(state, {
      type: "thread/loaded",
      threadId: run.threadId,
      messages: [],
      runs: [{ ...run, events: [] }],
    });
    state = chatReducer(state, {
      type: "sse/chunk",
      runId: run.id,
      chunk: { id: "1-0", runId: run.id, streamType: "content", chunk: "Hello" },
    });
    state = chatReducer(state, {
      type: "sse/snapshot",
      runId: run.id,
      run: { ...run, status: "running" },
      events: [event(1, "agent_started")],
    });

    expect(selectRunContent(state.runs[run.id])).toBe("Hello");
    expect(state.runs[run.id].events).toHaveLength(1);
  });

  it("deduplicates replayed chunks and events", () => {
    const view = makeView({ events: [event(1, "agent_started")] });
    let state: ChatState = {
      ...initialChatState,
      threadId: view.run.threadId,
      phase: "ready" as const,
      runs: { [view.run.id]: view },
      runOrder: [view.run.id],
      activeRunId: view.run.id,
    };
    state = chatReducer(state, {
      type: "sse/event",
      runId: view.run.id,
      event: event(1, "agent_started"),
    });
    const chunk = {
      id: "2-0",
      runId: view.run.id,
      streamType: "thinking" as const,
      chunk: "Plan",
    };
    state = chatReducer(state, { type: "sse/chunk", runId: view.run.id, chunk });
    state = chatReducer(state, { type: "sse/chunk", runId: view.run.id, chunk });

    expect(state.runs[view.run.id].events).toHaveLength(1);
    expect(state.runs[view.run.id].chunks).toHaveLength(1);
  });

  it("uses run status as the authoritative terminal state", () => {
    const completed = makeView({ run: makeRun({ status: "completed" }) });
    const failed = makeView({ run: makeRun({ status: "failed" }) });

    expect(selectRunPhase(completed)).toMatchObject({
      key: "completed",
      active: false,
    });
    expect(selectRunPhase(failed)).toMatchObject({ key: "failed", active: false });
  });

  it("derives the active phase from the latest semantic events", () => {
    const provisioning = makeView({
      events: [event(1, "sandbox_provisioning")],
    });
    const thinking = makeView({
      events: [event(1, "agent_started"), event(2, "agent_thinking")],
    });
    const tool = makeView({
      events: [
        event(1, "agent_started"),
        event(2, "tool_call_started", { name: "web_search", toolCallId: "a" }),
      ],
    });

    expect(selectRunPhase(provisioning).label).toBe("Preparing sandbox");
    expect(selectRunPhase(thinking).label).toBe("Thinking");
    expect(selectRunPhase(tool).label).toBe("Running web_search");
  });

  it("does not let a stale thread response replace the selected thread", () => {
    const state = chatReducer(
      { ...initialChatState, threadId: "new", phase: "loading" },
      { type: "thread/loaded", threadId: "old", messages: [], runs: [] }
    );
    expect(state.threadId).toBe("new");
    expect(state.phase).toBe("loading");
  });

  it("keeps the first turn when a second run is created", () => {
    const firstRun = makeRun({ id: "run-1" });
    const secondRun = makeRun({
      id: "run-2",
      prompt: "Follow up",
      createdAt: "2026-07-18T10:01:00.000Z",
      updatedAt: "2026-07-18T10:01:00.000Z",
    });
    let state = chatReducer(initialChatState, {
      type: "thread/loading",
      threadId: firstRun.threadId,
    });
    state = chatReducer(state, {
      type: "thread/loaded",
      threadId: firstRun.threadId,
      messages: [],
      runs: [{ ...firstRun, events: [] }],
    });
    state = chatReducer(state, { type: "run/created", run: secondRun });

    expect(state.runOrder).toEqual(["run-1", "run-2"]);
    expect(state.activeRunId).toBe("run-2");
  });
});

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    status: "running",
    prompt: "Research this",
    derivedUiState: "running",
    createdAt: "2026-07-18T10:00:00.000Z",
    updatedAt: "2026-07-18T10:00:01.000Z",
    ...overrides,
  };
}

function makeView(overrides: Partial<ChatRunState> = {}): ChatRunState {
  return {
    run: makeRun(),
    events: [],
    chunks: [],
    artifacts: [],
    sources: [],
    usage: [],
    ...overrides,
  };
}

function event(seq: number, type: string, payload: unknown = {}): RunEventDTO {
  return {
    seq,
    type,
    payload,
    createdAt: `2026-07-18T10:00:0${seq}.000Z`,
  };
}

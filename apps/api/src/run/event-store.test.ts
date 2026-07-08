import { describe, expect, it } from "vitest";
import {
  RUN_EVENT_TYPES,
  isRunEventTypeBefore,
  validateRunEventPayload,
  type RunEventPayloadMap,
  type RunEventType,
} from "./event-store.js";

const VALID_PAYLOADS: { [T in RunEventType]: RunEventPayloadMap[T] } = {
  run_created: null,
  sandbox_provisioning: null,
  sandbox_ready: null,
  runner_started: null,
  agent_started: null,
  agent_thinking: { model: "gpt-5" },
  agent_message: { messageId: "msg_1" },
  tool_call_started: {
    toolCallId: "tool_1",
    name: "fetch_url",
    args: { url: "https://example.com" },
  },
  tool_call_completed: {
    toolCallId: "tool_1",
    name: "fetch_url",
    result: { ok: true },
    durationMs: 42,
  },
  tool_call_failed: {
    toolCallId: "tool_1",
    name: "fetch_url",
    error: "timeout",
    durationMs: 42,
  },
  file_written: {
    fileId: "file_1",
    path: "/workspace/report.md",
    size: 12,
    contentHash: "sha256:abc",
  },
  source_recorded: {
    sourceId: "source_1",
    kind: "search_result",
    uri: "https://example.com",
    title: "Example",
  },
  artifact_started: {
    artifactId: "artifact_1",
    title: "Report",
    kind: "text",
  },
  artifact_delta: {
    artifactId: "artifact_1",
    deltaText: "hello",
  },
  artifact_created: {
    artifactId: "artifact_1",
    title: "Report",
    kind: "text",
    version: 1,
  },
  artifact_updated: {
    artifactId: "artifact_1",
    title: "Report",
    kind: "text",
    version: 2,
    previousVersion: 1,
  },
  artifact_failed: {
    artifactId: "artifact_1",
    error: "render failed",
  },
  run_completed: {
    totalTokens: 100,
    durationMs: 1000,
  },
  run_failed: {
    errorCode: "LLM_PROXY_FAILED",
  },
  run_timeout: {
    lastHeartbeatAt: "2026-07-05T00:00:00.000Z",
  },
  run_cancelled: null,
  run_waiting_for_input: {
    question: "Choose a branch",
    options: ["main", "dev"],
  },
};

describe("run event partial ordering helpers", () => {
  it("run_created < sandbox_provisioning < sandbox_ready < agent_started", () => {
    expect(isRunEventTypeBefore("run_created", "sandbox_provisioning")).toBe(
      true,
    );
    expect(isRunEventTypeBefore("sandbox_provisioning", "sandbox_ready")).toBe(
      true,
    );
    expect(isRunEventTypeBefore("sandbox_ready", "agent_started")).toBe(true);
  });

  it("tool_call_started < tool_call_completed|tool_call_failed", () => {
    expect(isRunEventTypeBefore("tool_call_started", "tool_call_completed")).toBe(
      true,
    );
    expect(isRunEventTypeBefore("tool_call_started", "tool_call_failed")).toBe(
      true,
    );
  });

  it("artifact_started < artifact_created|artifact_failed", () => {
    expect(isRunEventTypeBefore("artifact_started", "artifact_created")).toBe(
      true,
    );
    expect(isRunEventTypeBefore("artifact_started", "artifact_failed")).toBe(
      true,
    );
  });
});

describe("validateRunEventPayload", () => {
  it("payload schema validates against every AgentEventPayloadMap key", () => {
    for (const type of RUN_EVENT_TYPES) {
      expect(validateRunEventPayload(type, VALID_PAYLOADS[type])).toEqual({
        ok: true,
      });
    }
  });

  it("rejects mismatched shape -> VALIDATION_FAILED", () => {
    expect(
      validateRunEventPayload("tool_call_started", {
        name: "fetch_url",
        args: { url: "https://example.com" },
      }),
    ).toEqual({ ok: false, message: "payload missing toolCallId" });
  });

  it("agent_thinking/agent_message payloads are mutually exclusive with tool call fields", () => {
    expect(
      validateRunEventPayload("agent_thinking", {
        model: "gpt-5",
        toolCallId: "tool_1",
      }),
    ).toEqual({
      ok: false,
      message: "payload has unexpected field toolCallId",
    });

    expect(
      validateRunEventPayload("agent_message", {
        messageId: "msg_1",
        toolCallId: "tool_1",
      }),
    ).toEqual({
      ok: false,
      message: "payload has unexpected field toolCallId",
    });
  });
});

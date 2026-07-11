import { describe, expect, it } from "vitest";
import {
  CAPTURED_SANDBOX_OUTPUT_MAX_LENGTH,
  SCRIPTED_INGEST_RUNNER_SCRIPT,
  sandboxNameForWorkspace,
  sandboxStatusFromVercel,
  truncateCapturedSandboxOutput,
} from "./workspace-sandbox.js";

describe("workspace sandbox helpers", () => {
  it("sandbox name generation is deterministic and workspace-scoped", () => {
    expect(sandboxNameForWorkspace("Workspace_ABC")).toBe(
      "cap-ws-workspace-abc",
    );
    expect(sandboxNameForWorkspace("Workspace_ABC")).toBe(
      sandboxNameForWorkspace("Workspace_ABC"),
    );
    expect(sandboxNameForWorkspace("Workspace_XYZ")).not.toBe(
      sandboxNameForWorkspace("Workspace_ABC"),
    );
  });

  it("provider state conversion maps Vercel status to SandboxStatus", () => {
    expect(sandboxStatusFromVercel("pending")).toBe("pending");
    expect(sandboxStatusFromVercel("running")).toBe("ready");
    expect(sandboxStatusFromVercel("stopping")).toBe("warm");
    expect(sandboxStatusFromVercel("snapshotting")).toBe("warm");
    expect(sandboxStatusFromVercel("stopped")).toBe("stopped");
    expect(sandboxStatusFromVercel("failed")).toBe("failed");
    expect(sandboxStatusFromVercel("aborted")).toBe("failed");
    expect(sandboxStatusFromVercel("mystery")).toBe("unknown");
  });

  it("scripted ingest runner uses distinct seq values for tool lifecycle events", () => {
    expect(SCRIPTED_INGEST_RUNNER_SCRIPT).toContain("eventSeq: 3");
    expect(SCRIPTED_INGEST_RUNNER_SCRIPT).toContain("eventSeq: 4");
    expect(SCRIPTED_INGEST_RUNNER_SCRIPT).toContain(
      'seq: 5, type: "run_completed"',
    );
  });

  it("truncates captured sandbox stdout/stderr before returning control-plane output", () => {
    const atLimit = "x".repeat(CAPTURED_SANDBOX_OUTPUT_MAX_LENGTH);
    expect(truncateCapturedSandboxOutput(atLimit)).toEqual({
      text: atLimit,
      truncated: false,
    });

    const overLimit = atLimit + "tail";
    expect(truncateCapturedSandboxOutput(overLimit)).toEqual({
      text: atLimit + "\n…[truncated]",
      truncated: true,
    });
  });
});

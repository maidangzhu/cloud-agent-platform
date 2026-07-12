import { describe, expect, it } from "vitest";
import { AGENT_LOOP_SANDBOX_SCRIPT } from "./sandbox-script.js";

describe("deterministic agent-loop sandbox script", () => {
  it("allocates distinct seq values for tool start, effect, and completion", () => {
    expect(AGENT_LOOP_SANDBOX_SCRIPT).toContain(
      "const startedEventSeq = seq++;",
    );
    expect(AGENT_LOOP_SANDBOX_SCRIPT).toContain(
      "const effectEventSeq = seq++;",
    );
    expect(AGENT_LOOP_SANDBOX_SCRIPT).toContain(
      "const completedEventSeq = seq++;",
    );
    expect(AGENT_LOOP_SANDBOX_SCRIPT).not.toContain("eventSeq: seq - 1");
  });
});

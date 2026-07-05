import { describe, expect, it } from "vitest";
import {
  sandboxNameForWorkspace,
  sandboxStatusFromVercel,
} from "./workspace-sandbox";

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
});

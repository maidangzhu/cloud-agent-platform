import { describe, expect, it, vi } from "vitest";
import {
  canReuseEphemeralSandbox,
  disableWorkspaceSandboxPersistence,
  isSandboxNotFoundError,
  resolveWorkspaceSandboxSource,
} from "./factory.js";

describe("Vercel sandbox acquisition", () => {
  it("only reuses an ephemeral sandbox while its session is alive", () => {
    expect(canReuseEphemeralSandbox("pending")).toBe(true);
    expect(canReuseEphemeralSandbox("running")).toBe(true);
    expect(canReuseEphemeralSandbox("stopped")).toBe(false);
    expect(canReuseEphemeralSandbox("snapshotting")).toBe(false);
    expect(canReuseEphemeralSandbox("failed")).toBe(false);
  });

  it("only treats provider not-found responses as fresh-create fallback", () => {
    expect(isSandboxNotFoundError(new Error("Status code 404 is not ok"))).toBe(
      true,
    );
    expect(isSandboxNotFoundError(new Error("snapshot_not_found"))).toBe(true);
    expect(isSandboxNotFoundError(new Error("Status code 500 is not ok"))).toBe(
      false,
    );
  });

  it("starts fresh workspaces from the configured golden snapshot", () => {
    expect(
      resolveWorkspaceSandboxSource({ VERCEL_BASE_SNAPSHOT_ID: " snap_base " }),
    ).toEqual({
      source: { type: "snapshot", snapshotId: "snap_base" },
    });
    expect(resolveWorkspaceSandboxSource({})).toEqual({ runtime: "node24" });
  });

  it("disables persistence when acquiring existing sandboxes", async () => {
    const update = vi.fn(async () => undefined);

    await disableWorkspaceSandboxPersistence({ update });

    expect(update).toHaveBeenCalledWith({
      persistent: false,
      keepLastSnapshots: null,
    });
  });
});

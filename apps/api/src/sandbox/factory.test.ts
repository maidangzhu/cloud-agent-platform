import { describe, expect, it } from "vitest";
import {
  createSandboxCreationTracker,
  isSandboxNotFoundError,
} from "./factory.js";

describe("Vercel sandbox acquisition", () => {
  it("distinguishes a fresh provider sandbox from a resumed one", async () => {
    const resumed = createSandboxCreationTracker();
    expect(resumed.wasCreated()).toBe(false);

    const fresh = createSandboxCreationTracker();
    await fresh.onCreate();
    expect(fresh.wasCreated()).toBe(true);
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
});

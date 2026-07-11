import { describe, expect, it, vi } from "vitest";
import { VercelSandbox } from "./vercel-sandbox.js";

describe("VercelSandbox path wrapper", () => {
  it("rejects readFile paths outside the sandbox working directory before SDK access", async () => {
    const sdk = createFakeSdk();
    const sandbox = new VercelSandbox(sdk as never, { provider: "vercel" });

    await expect(sandbox.readFile("../secret.txt")).rejects.toThrow(
      /escapes workspace root/,
    );
    expect(sdk.readFileToBuffer).not.toHaveBeenCalled();
  });

  it("rejects writeFile paths outside the sandbox working directory before SDK access", async () => {
    const sdk = createFakeSdk();
    const sandbox = new VercelSandbox(sdk as never, { provider: "vercel" });

    await expect(sandbox.writeFile("/etc/passwd", "x")).rejects.toThrow(
      /escapes workspace root/,
    );
    expect(sdk.runCommand).not.toHaveBeenCalled();
    expect(sdk.writeFiles).not.toHaveBeenCalled();
  });

  it("rejects readdir paths outside the sandbox working directory before SDK access", async () => {
    const sdk = createFakeSdk();
    const sandbox = new VercelSandbox(sdk as never, { provider: "vercel" });

    await expect(sandbox.readdir("../../")).rejects.toThrow(
      /escapes workspace root/,
    );
    expect(sdk.runCommand).not.toHaveBeenCalled();
  });
});

function createFakeSdk() {
  return {
    readFileToBuffer: vi.fn(async () => Buffer.from("ok")),
    runCommand: vi.fn(async () => ({
      exitCode: 0,
      stdout: async () => "",
      stderr: async () => "",
    })),
    writeFiles: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => ({ snapshotId: "snap-1" })),
    stop: vi.fn(async () => undefined),
  };
}

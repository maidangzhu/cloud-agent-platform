import { describe, expect, it } from "vitest";
import { buildPiRuntimeStartConfig } from "./config.js";
import { installPiRuntimeInSandbox } from "../sandbox/workspace-sandbox.js";

describe("Pi runtime sandbox install", () => {
  it("writes config, runtime script, and package manifest without DB/Auth/provider secrets", async () => {
    const writes: Record<string, string> = {};
    const sandbox = {
      workingDir: "/vercel/sandbox",
      writeFile: async (path: string, content: string) => {
        writes[path] = content;
      },
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      stop: async () => undefined,
      getState: () => ({ provider: "fake" }),
    };
    const config = buildPiRuntimeStartConfig({
      apiBaseUrl: "https://api.sandbox.maidang.me",
      runToken: "scoped-run-token",
      run: {
        id: "run_1",
        workspaceId: "workspace_1",
        threadId: "thread_1",
        userId: "user_1",
        prompt: "smoke",
        maxDurationSec: 120,
      },
    });

    await installPiRuntimeInSandbox({ sandbox, config });

    expect(Object.keys(writes).sort()).toEqual([
      "package.json",
      "pi-runtime-config.json",
      "pi-runtime.mjs",
    ]);
    expect(writes["pi-runtime.mjs"]).toContain("@earendil-works/pi-agent-core");
    expect(writes["pi-runtime.mjs"]).toContain("@earendil-works/pi-ai");
    expect(writes["pi-runtime.mjs"]).toContain("/heartbeat");
    expect(writes["pi-runtime.mjs"]).not.toContain("terminate: true");
    expect(writes["pi-runtime.mjs"]).toContain(
      'Type.Enum(["text", "code", "sheet", "image"])',
    );
    expect(writes["pi-runtime.mjs"]).toContain("runtime-create-artifact");
    expect(writes["package.json"]).toContain("@earendil-works/pi-agent-core");
    expect(writes["package.json"]).toContain("@earendil-works/pi-ai");
    const configText = writes["pi-runtime-config.json"];
    expect(configText).toContain("scoped-run-token");
    expect(configText).not.toContain("DATABASE_URL");
    expect(configText).not.toContain("BETTER_AUTH_SECRET");
    expect(configText).not.toContain("OPENAI_API_KEY");
    expect(configText).not.toContain("REDIS_URL");
  });
});

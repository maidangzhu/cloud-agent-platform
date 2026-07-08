import { describe, expect, it } from "vitest";
import { buildPiRuntimeStartConfig } from "./config.js";
import {
  installPiRuntimeInSandbox,
  runPiRuntimeInSandbox,
} from "../sandbox/workspace-sandbox.js";

describe("Pi runtime sandbox install", () => {
  it("writes config, runtime script, and package manifest without DB/Auth/provider secrets", async () => {
    const writes: Record<string, string> = {};
    const sandbox = {
      workingDir: "/vercel/sandbox",
      readFile: async (path: string) => writes[path] ?? "",
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
    expect(writes["pi-runtime.mjs"]).toContain(
      'Type.Enum(["text", "code", "sheet", "image"])',
    );
    expect(writes["pi-runtime.mjs"]).toContain("runtime-create-artifact");
    expect(writes["pi-runtime.mjs"]).toContain("terminate: true");
    expect(writes["pi-runtime.mjs"]).toContain("process.exit(0)");
    expect(writes["package.json"]).toContain("@earendil-works/pi-agent-core");
    expect(writes["package.json"]).toContain("@earendil-works/pi-ai");
    const configText = writes["pi-runtime-config.json"];
    expect(configText).toContain("scoped-run-token");
    expect(configText).not.toContain("DATABASE_URL");
    expect(configText).not.toContain("BETTER_AUTH_SECRET");
    expect(configText).not.toContain("OPENAI_API_KEY");
    expect(configText).not.toContain("REDIS_URL");
  });

  it("returns captured runtime output when the Vercel command stream ends early", async () => {
    const writes: Record<string, string> = {};
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
    const sandbox = {
      workingDir: "/vercel/sandbox",
      readFile: async (path: string) => {
        if (!(path in writes)) throw new Error(`missing ${path}`);
        return writes[path] ?? "";
      },
      writeFile: async (path: string, content: string) => {
        writes[path] = content;
      },
      exec: async (command: string) => {
        if (command.includes("npm install")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (command.includes("node pi-runtime.mjs")) {
          const prefix = command.match(/(pi-runtime-[a-f0-9-]+)/)?.[1];
          if (!prefix) throw new Error("missing capture prefix");
          writes[`${prefix}.stdout.log`] = "{\"completed\":true}\n";
          writes[`${prefix}.stderr.log`] = "";
          writes[`${prefix}.exit-code.txt`] = "0";
          throw new Error("Stream ended before command finished");
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      stop: async () => undefined,
      getState: () => ({ provider: "fake" }),
    };

    const result = await runPiRuntimeInSandbox({ sandbox, config });

    expect(result).toEqual({
      exitCode: 0,
      stdout: "{\"completed\":true}\n",
      stderr: "",
    });
  });
});

import { describe, expect, it } from "vitest";
import { buildPiRuntimeStartConfig } from "./config.js";
import {
  installPiRuntimeInSandbox,
  runPiRuntimeInSandbox,
  startPiRuntimeInSandbox,
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
	    expect(writes["pi-runtime.mjs"]).toContain('name: "read_file"');
	    expect(writes["pi-runtime.mjs"]).toContain('name: "list_directory"');
	    expect(writes["pi-runtime.mjs"]).toContain('name: "list_files"');
    expect(writes["pi-runtime.mjs"]).toContain('name: "web_search"');
    expect(writes["pi-runtime.mjs"]).toContain("config.searchProxyUrl");
	    expect(writes["pi-runtime.mjs"]).toContain('name: "fetch_url"');
	    expect(writes["pi-runtime.mjs"]).toContain("config.toolPolicy?.allowNetwork");
	    expect(writes["pi-runtime.mjs"]).toContain('config.ingestUrl + "/sources"');
	    expect(writes["pi-runtime.mjs"]).toContain('name: "run_command"');
	    expect(writes["pi-runtime.mjs"]).toContain('spawn("bash"');
	    expect(writes["pi-runtime.mjs"]).toContain("/heartbeat");
    expect(writes["pi-runtime.mjs"]).toContain('Accept: "text/event-stream"');
    expect(writes["pi-runtime.mjs"]).toContain("stream: true");
    expect(writes["pi-runtime.mjs"]).toContain('postRunEvent("agent_thinking"');
    expect(writes["pi-runtime.mjs"]).toContain("await waitForPendingLlmStreams()");
    expect(writes["pi-runtime.mjs"]).toContain("applyWorkspaceFilesToSync()");
    expect(writes["pi-runtime.mjs"]).toContain("fs.rmSync(resolved.absolute");
    expect(writes["pi-runtime.mjs"]).not.toContain('postStreamChunk("content"');
    expect(writes["pi-runtime.mjs"]).not.toContain('postStreamChunk("thinking"');
    expect(writes["pi-runtime.mjs"]).toContain(
      'Type.Enum(["text", "code", "sheet", "image"])',
    );
    expect(writes["pi-runtime.mjs"]).toContain("runtime-create-artifact");
    expect(writes["pi-runtime.mjs"]).toContain("terminate: true");
    expect(writes["pi-runtime.mjs"]).toContain('type: "function"');
    expect(writes["pi-runtime.mjs"]).toContain(
      "function: { name: forceableRequiredTools[0] }",
    );
    expect(writes["pi-runtime.mjs"]).toContain('"pi-runtime-tools"');
    expect(writes["pi-runtime.mjs"]).toContain(
      "forceableRequiredTools.includes(tool.name)",
    );
    expect(writes["pi-runtime.mjs"]).toContain(
      'lastMessage?.role === "toolResult"',
    );
    expect(writes["pi-runtime.mjs"]).toContain(
      "buildRequiredToolRepairMessages",
    );
    expect(writes["pi-runtime.mjs"]).toContain("Previous tool result:");
    expect(writes["pi-runtime.mjs"]).toContain("REQUIRED_TOOL_NOT_EXECUTED:");
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

  it("starts the runtime detached without waiting for the agent to finish", async () => {
    const writes: Record<string, string> = {};
    const commands: string[] = [];
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
      readFile: async (path: string) => writes[path] ?? "",
      writeFile: async (path: string, content: string) => {
        writes[path] = content;
      },
      exec: async (command: string) => {
        commands.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      execDetached: async (command: string) => {
        commands.push(command);
        return { commandId: "cmd_1" };
      },
      stop: async () => undefined,
      getState: () => ({ provider: "fake" }),
    };

    const result = await startPiRuntimeInSandbox({ sandbox, config });

    expect(result).toEqual({ started: true, commandId: "cmd_1" });
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("npm install");
    expect(commands[1]).toBe("node pi-runtime.mjs");
  });
});

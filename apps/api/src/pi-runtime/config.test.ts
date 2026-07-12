import { describe, expect, it } from "vitest";
import { createPiRuntimeAgentShell } from "./agent.js";
import {
  buildPiRuntimeStartConfig,
  pickPiRuntimeSandboxEnv,
  validatePiRuntimeStartConfig,
} from "./config.js";

const run = {
  id: "run_123",
  workspaceId: "ws_123",
  threadId: "thr_123",
  userId: "usr_123",
  prompt: "Research hosted control planes.",
  maxDurationSec: 1800,
};

describe("Pi runtime start protocol", () => {
  it("derives hosted Control Plane URLs from a public API base", () => {
    const config = buildPiRuntimeStartConfig({
      apiBaseUrl: "https://api.sandbox.maidang.me/",
      runToken: "scoped-run-token",
      run,
    });

	    expect(config).toMatchObject({
      apiBaseUrl: "https://api.sandbox.maidang.me",
      ingestUrl: "https://api.sandbox.maidang.me/api/ingest",
      llmProxyUrl: "https://api.sandbox.maidang.me/api/llm-proxy",
      searchProxyUrl: "https://api.sandbox.maidang.me/api/search-proxy",
      controlUrl: "https://api.sandbox.maidang.me/api/runs/run_123/control",
      llmProvider: "real",
      modelHint: "pi-runtime",
      thinkingLevel: "medium",
      searchProvider: "fake",
	      maxSteps: 80,
	      workspaceRoot: "/workspace",
	      toolPolicy: {
	        allowNetwork: true,
	        allowRunCommand: true,
	        denyCommands: ["rm -rf", "sudo", "dd"],
	      },
	      packages: {
        agentCore: "@earendil-works/pi-agent-core",
        ai: "@earendil-works/pi-ai",
        version: "0.80.3",
      },
    });
    expect(validatePiRuntimeStartConfig(config)).toEqual({ ok: true });
  });

  it("rejects localhost callback URLs for sandbox runtime config", () => {
    const config = buildPiRuntimeStartConfig({
      apiBaseUrl: "http://localhost:8787",
      runToken: "scoped-run-token",
      run,
    });

    expect(validatePiRuntimeStartConfig(config)).toEqual({
      ok: false,
      message: "apiBaseUrl must be public, got localhost",
    });
  });

  it("carries a validated workspace revision diff into the runtime config", () => {
    const config = buildPiRuntimeStartConfig({
      apiBaseUrl: "https://api.sandbox.maidang.me",
      runToken: "scoped-run-token",
      run,
      workspaceSyncPlan: {
        fromRevision: "3",
        targetRevision: "5",
        filesToSync: [
          {
            path: "notes/research.md",
            kind: "text",
            content: "hydrated",
            isDeleted: false,
            revision: "4",
          },
          {
            path: "tmp/old.txt",
            kind: "text",
            isDeleted: true,
            revision: "5",
          },
        ],
      },
    });

    expect(config.syncTargetRevision).toBe("5");
    expect(config.filesToSync).toHaveLength(2);
    expect(validatePiRuntimeStartConfig(config)).toEqual({ ok: true });

    config.filesToSync[0]!.path = "../escape.txt";
    expect(validatePiRuntimeStartConfig(config)).toEqual({
      ok: false,
      message: "filesToSync path is invalid",
    });
  });

  it("does not pass database, auth, Redis, or provider secrets to sandbox env", () => {
    const env = pickPiRuntimeSandboxEnv({
      CAP_PI_RUNTIME_CONFIG_FILE: "runtime.json",
      DATABASE_URL: "postgres://secret",
      BETTER_AUTH_SECRET: "secret",
      REDIS_URL: "redis://secret",
      OPENAI_API_KEY: "secret",
      EXA_API_KEY: "secret",
    });

    expect(env).toEqual({ CAP_PI_RUNTIME_CONFIG_FILE: "runtime.json" });
  });

  it("constructs a Pi Agent shell without starting product execution", () => {
    const config = buildPiRuntimeStartConfig({
      apiBaseUrl: "https://api.sandbox.maidang.me",
      runToken: "scoped-run-token",
      run,
    });
    const shell = createPiRuntimeAgentShell(config);

    expect(shell.model.provider).toBe("cap-control-plane");
    expect(shell.model.baseUrl).toBe(config.llmProxyUrl);
	    expect(shell.agent.state.tools.map((tool) => tool.name)).toEqual([
	      "read_file",
	      "list_directory",
	      "list_files",
	      "web_search",
	      "fetch_url",
	      "write_file",
	      "run_command",
	      "create_artifact",
	    ]);
    expect(shell.agent.state.messages).toEqual([]);
  });
});

export const PI_RUNTIME_PACKAGES = {
  agentCore: "@earendil-works/pi-agent-core",
  ai: "@earendil-works/pi-ai",
  version: "0.80.3",
} as const;

export type PiRuntimeToolPolicy = {
  allowNetwork: boolean;
  allowRunCommand: boolean;
  denyCommands: string[];
};

export type PiRuntimeStartConfig = {
  runId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  prompt: string;
  workspaceRoot: string;
  apiBaseUrl: string;
  ingestUrl: string;
  llmProxyUrl: string;
  searchProxyUrl: string;
  controlUrl: string;
  runToken: string;
  llmProvider: "fake" | "real";
  modelHint: string;
  maxSteps: number;
  maxDurationSec: number;
  toolPolicy: PiRuntimeToolPolicy;
  packages: typeof PI_RUNTIME_PACKAGES;
};

export type BuildPiRuntimeStartConfigInput = {
  apiBaseUrl: string;
  runToken: string;
  run: {
    id: string;
    workspaceId: string;
    threadId: string;
    userId: string;
    prompt: string;
    maxDurationSec: number;
  };
  workspaceRoot?: string;
  maxSteps?: number;
  llmProvider?: "fake" | "real";
  modelHint?: string;
  toolPolicy?: Partial<PiRuntimeToolPolicy>;
};

const DEFAULT_TOOL_POLICY: PiRuntimeToolPolicy = {
  allowNetwork: true,
  allowRunCommand: true,
  denyCommands: ["rm -rf", "sudo", "dd"],
};

export function buildPiRuntimeStartConfig(
  input: BuildPiRuntimeStartConfigInput,
): PiRuntimeStartConfig {
  const apiBaseUrl = input.apiBaseUrl.replace(/\/$/, "");
  const runId = input.run.id;

  return {
    runId,
    workspaceId: input.run.workspaceId,
    threadId: input.run.threadId,
    userId: input.run.userId,
    prompt: input.run.prompt,
    workspaceRoot: input.workspaceRoot ?? "/workspace",
    apiBaseUrl,
    ingestUrl: `${apiBaseUrl}/api/ingest`,
    llmProxyUrl: `${apiBaseUrl}/api/llm-proxy`,
    searchProxyUrl: `${apiBaseUrl}/api/search-proxy`,
    controlUrl: `${apiBaseUrl}/api/runs/${runId}/control`,
    runToken: input.runToken,
    llmProvider: input.llmProvider ?? "real",
    modelHint: input.modelHint ?? "pi-runtime",
    maxSteps: input.maxSteps ?? 80,
    maxDurationSec: input.run.maxDurationSec,
    toolPolicy: {
      ...DEFAULT_TOOL_POLICY,
      ...input.toolPolicy,
      denyCommands:
        input.toolPolicy?.denyCommands ?? DEFAULT_TOOL_POLICY.denyCommands,
    },
    packages: PI_RUNTIME_PACKAGES,
  };
}

export function validatePiRuntimeStartConfig(
  config: PiRuntimeStartConfig,
): { ok: true } | { ok: false; message: string } {
  const urls = [
    ["apiBaseUrl", config.apiBaseUrl],
    ["ingestUrl", config.ingestUrl],
    ["llmProxyUrl", config.llmProxyUrl],
    ["searchProxyUrl", config.searchProxyUrl],
    ["controlUrl", config.controlUrl],
  ] as const;

  for (const [field, value] of urls) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { ok: false, message: `${field} must be an absolute URL` };
    }
    if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
      return { ok: false, message: `${field} must be public, got localhost` };
    }
  }

  if (!config.runToken.trim()) {
    return { ok: false, message: "runToken is required" };
  }
  if (!config.prompt.trim()) {
    return { ok: false, message: "prompt is required" };
  }
  if (config.llmProvider !== "fake" && config.llmProvider !== "real") {
    return { ok: false, message: "llmProvider must be fake or real" };
  }
  if (!config.modelHint.trim()) {
    return { ok: false, message: "modelHint is required" };
  }
  if (config.maxSteps < 1) {
    return { ok: false, message: "maxSteps must be positive" };
  }
  if (config.maxDurationSec < 1) {
    return { ok: false, message: "maxDurationSec must be positive" };
  }

  return { ok: true };
}

export function pickPiRuntimeSandboxEnv(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  return {
    CAP_PI_RUNTIME_CONFIG_FILE:
      env.CAP_PI_RUNTIME_CONFIG_FILE ?? "pi-runtime-config.json",
  };
}

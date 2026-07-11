import { randomUUID } from "node:crypto";
import { prisma, type SandboxStatus } from "@cap/db";
import { AGENT_LOOP_SANDBOX_SCRIPT } from "../agent-loop/sandbox-script.js";
import { PI_RUNTIME_SANDBOX_SCRIPT } from "../pi-runtime/sandbox-script.js";
import type { PiRuntimeStartConfig } from "../pi-runtime/config.js";
import { transitionRun } from "../run/transition-run.js";

type WorkspaceSandboxRow = Awaited<
  ReturnType<typeof prisma.workspaceSandboxInstance.findUniqueOrThrow>
>;

type VercelSandboxHandle = {
  workingDir: string;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exec(
    command: string,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  stop(): Promise<void>;
  getState(): { provider: string; sandboxName?: string; snapshotId?: string };
};

export const CAPTURED_SANDBOX_OUTPUT_MAX_LENGTH = 50_000;
const CAPTURED_SANDBOX_OUTPUT_TRUNCATED_SUFFIX = "\n…[truncated]";

export type WorkspaceSandboxClaim = {
  instance: WorkspaceSandboxRow;
  sandbox: VercelSandboxHandle;
  reused: boolean;
};

export function sandboxNameForWorkspace(workspaceId: string): string {
  return `cap-ws-${workspaceId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

function sandboxNameForNewWorkspaceInstance(
  workspaceId: string,
  hasExistingInstance: boolean,
): string {
  const base = sandboxNameForWorkspace(workspaceId);
  return hasExistingInstance ? `${base}-${randomUUID().slice(0, 8)}` : base;
}

export function sandboxStatusFromVercel(
  status: string,
): SandboxStatus | "unknown" {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return "ready";
    case "stopping":
    case "snapshotting":
      return "warm";
    case "stopped":
      return "stopped";
    case "failed":
    case "aborted":
      return "failed";
    default:
      return "unknown";
  }
}

export async function getOrCreateWorkspaceSandbox(params: {
  workspaceId: string;
  runId: string;
  timeoutMs?: number;
}): Promise<WorkspaceSandboxClaim> {
  const reusable = await claimExistingWorkspaceSandbox(
    params.workspaceId,
    params.runId,
    ["warm", "ready"],
    "ready",
  );
  if (reusable) {
    const sandbox = await getVercelSandboxByName(
      reusable.sandboxName,
      params.timeoutMs,
    );
    await markSandboxReady(reusable.id, sandbox);
    const updated = await prisma.workspaceSandboxInstance.findUniqueOrThrow({
      where: { id: reusable.id },
    });
    return { instance: updated, sandbox, reused: true };
  }

  const stopped = await claimExistingWorkspaceSandbox(
    params.workspaceId,
    params.runId,
    ["stopped"],
    "provisioning",
  );
  const existingCount = stopped
    ? 0
    : await prisma.workspaceSandboxInstance.count({
        where: { workspaceId: params.workspaceId },
      });
  const instance =
    stopped ??
    (await prisma.workspaceSandboxInstance.create({
      data: {
        id: randomUUID(),
        workspaceId: params.workspaceId,
        provider: "vercel",
        sandboxName: sandboxNameForNewWorkspaceInstance(
          params.workspaceId,
          existingCount > 0,
        ),
        status: "provisioning",
        currentRunId: params.runId,
      },
    }));

  try {
    const sandbox = await getVercelSandboxByName(
      instance.sandboxName,
      params.timeoutMs,
    );
    await markSandboxReady(instance.id, sandbox);
    const updated = await prisma.workspaceSandboxInstance.findUniqueOrThrow({
      where: { id: instance.id },
    });
    return { instance: updated, sandbox, reused: Boolean(stopped) };
  } catch (error) {
    await prisma.workspaceSandboxInstance.update({
      where: { id: instance.id },
      data: {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

export async function releaseWorkspaceSandboxForRun(
  runId: string,
  status: Extract<SandboxStatus, "warm" | "stopped" | "failed"> = "warm",
): Promise<number> {
  const result = await prisma.workspaceSandboxInstance.updateMany({
    where: { currentRunId: runId },
    data: {
      currentRunId: null,
      status,
      lastUsedAt: new Date(),
    },
  });
  return result.count;
}

export async function sweepOrphanWorkspaceSandboxes(params: {
  olderThan: Date;
  stopProvider?: boolean;
}): Promise<number> {
  const candidates = await prisma.workspaceSandboxInstance.findMany({
    where: {
      status: { in: ["warm", "ready"] },
      lastUsedAt: { lt: params.olderThan },
    },
  });

  let stopped = 0;
  for (const candidate of candidates) {
    const activeRun = candidate.currentRunId
      ? await prisma.agentRun.findFirst({
          where: {
            id: candidate.currentRunId,
            status: {
              in: [
                "created",
                "provisioning_sandbox",
                "running",
                "waiting_for_input",
                "cancel_requested",
              ],
            },
          },
        })
      : null;
    if (activeRun) continue;

    if (params.stopProvider) {
      await stopVercelSandboxByName(candidate.sandboxName).catch(() => undefined);
    }
    const result = await prisma.workspaceSandboxInstance.updateMany({
      where: { id: candidate.id, updatedAt: candidate.updatedAt },
      data: { status: "stopped", currentRunId: null, lastUsedAt: new Date() },
    });
    stopped += result.count;
  }
  return stopped;
}

export async function stopWorkspaceSandboxByName(
  sandboxName: string,
): Promise<void> {
  await stopVercelSandboxByName(sandboxName);
}

export async function runScriptedIngestRunnerInSandbox(params: {
  sandbox: VercelSandboxHandle;
  ingestBaseUrl: string;
  runToken: string;
  mode?: "complete";
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const manifest = {
    ingestBaseUrl: params.ingestBaseUrl.replace(/\/$/, ""),
    runToken: params.runToken,
    mode: params.mode ?? "complete",
  };
  await params.sandbox.writeFile(
    "scripted-ingest-runner-manifest.json",
    JSON.stringify(manifest),
  );
  await params.sandbox.writeFile(
    "scripted-ingest-runner.mjs",
    SCRIPTED_INGEST_RUNNER_SCRIPT,
  );
  return params.sandbox.exec("node scripted-ingest-runner.mjs", {
    timeoutMs: 60_000,
  });
}

export async function installAgentLoopScriptInSandbox(params: {
  sandbox: VercelSandboxHandle;
  apiBaseUrl: string;
  runToken: string;
  runId: string;
  prompt: string;
  waitForInput?: { question: string; options?: string[] };
  updateArtifactId?: string;
}): Promise<void> {
  const manifest = {
    apiBaseUrl: params.apiBaseUrl.replace(/\/$/, ""),
    runToken: params.runToken,
    runId: params.runId,
    prompt: params.prompt,
    ...(params.waitForInput ? { waitForInput: params.waitForInput } : {}),
    ...(params.updateArtifactId
      ? { updateArtifactId: params.updateArtifactId }
      : {}),
  };
  await params.sandbox.writeFile(
    "agent-loop-manifest.json",
    JSON.stringify(manifest),
  );
  await params.sandbox.writeFile("agent-loop.mjs", AGENT_LOOP_SANDBOX_SCRIPT);
}

export async function runAgentLoopScriptInSandbox(params: {
  sandbox: VercelSandboxHandle;
  apiBaseUrl: string;
  runToken: string;
  runId: string;
  prompt: string;
  waitForInput?: { question: string; options?: string[] };
  updateArtifactId?: string;
  execTimeoutMs?: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  await installAgentLoopScriptInSandbox(params);
  try {
    return await params.sandbox.exec("node agent-loop.mjs", {
      timeoutMs: params.execTimeoutMs ?? 90_000,
    });
  } catch (error) {
    if (!isSandboxExecTimeoutError(error)) throw error;
    await transitionRun(params.runId, "timeout", [
      "provisioning_sandbox",
      "running",
      "cancel_requested",
    ]);
    await releaseWorkspaceSandboxForRun(params.runId, "warm");
    return {
      exitCode: 124,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function installPiRuntimeInSandbox(params: {
  sandbox: VercelSandboxHandle;
  config: PiRuntimeStartConfig;
}): Promise<void> {
  const packageJson = {
    type: "module",
    private: true,
    dependencies: {
      [params.config.packages.agentCore]: params.config.packages.version,
      [params.config.packages.ai]: params.config.packages.version,
    },
  };
  await params.sandbox.writeFile(
    "pi-runtime-config.json",
    JSON.stringify(params.config),
  );
  await params.sandbox.writeFile("pi-runtime.mjs", PI_RUNTIME_SANDBOX_SCRIPT);
  await params.sandbox.writeFile("package.json", JSON.stringify(packageJson));
}

export async function runPiRuntimeInSandbox(params: {
  sandbox: VercelSandboxHandle;
  config: PiRuntimeStartConfig;
  installTimeoutMs?: number;
  execTimeoutMs?: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  await installPiRuntimeInSandbox(params);
  const install = await params.sandbox.exec(
    "test -d node_modules/@earendil-works/pi-agent-core || npm install --omit=dev --no-audit --no-fund",
    { timeoutMs: params.installTimeoutMs ?? 180_000 },
  );
  if (install.exitCode !== 0) return install;
  return runCapturedPiRuntimeCommand(params.sandbox, "node pi-runtime.mjs", {
    timeoutMs: params.execTimeoutMs ?? 120_000,
  });
}

async function runCapturedPiRuntimeCommand(
  sandbox: VercelSandboxHandle,
  command: string,
  opts: { timeoutMs: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const prefix = `pi-runtime-${randomUUID()}`;
  const stdoutPath = `${prefix}.stdout.log`;
  const stderrPath = `${prefix}.stderr.log`;
  const exitPath = `${prefix}.exit-code.txt`;
  const wrapped = [
    "set +e",
    `${command} > ${stdoutPath} 2> ${stderrPath}`,
    `printf "%s" "$?" > ${exitPath}`,
  ].join("; ");

  try {
    const result = await sandbox.exec(wrapped, opts);
    return {
      exitCode: await readCapturedExitCode(sandbox, exitPath, result.exitCode),
      stdout: await readCapturedFile(sandbox, stdoutPath),
      stderr: await readCapturedFile(sandbox, stderrPath),
    };
  } catch (error) {
    if (!isSandboxStreamEndedError(error)) throw error;
  }

  const captured = await waitForCapturedPiRuntimeResult(sandbox, {
    exitPath,
    stdoutPath,
    stderrPath,
    timeoutMs: opts.timeoutMs,
  });
  if (captured) return captured;
  throw new Error(`captured command did not finish after ${opts.timeoutMs}ms`);
}

async function waitForCapturedPiRuntimeResult(
  sandbox: VercelSandboxHandle,
  files: {
    exitPath: string;
    stdoutPath: string;
    stderrPath: string;
    timeoutMs: number;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string } | null> {
  const deadline = Date.now() + files.timeoutMs;
  while (Date.now() < deadline) {
    try {
      const exitCode = await readCapturedExitCode(sandbox, files.exitPath);
      return {
        exitCode,
        stdout: await readCapturedFile(sandbox, files.stdoutPath),
        stderr: await readCapturedFile(sandbox, files.stderrPath),
      };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return null;
}

async function readCapturedExitCode(
  sandbox: VercelSandboxHandle,
  path: string,
  fallback?: number,
): Promise<number> {
  let raw: string;
  try {
    raw = await sandbox.readFile(path);
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw error;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(parsed) ? parsed : (fallback ?? 1);
}

async function readCapturedFile(
  sandbox: VercelSandboxHandle,
  path: string,
): Promise<string> {
  try {
    return truncateCapturedSandboxOutput(await sandbox.readFile(path)).text;
  } catch {
    return "";
  }
}

export function truncateCapturedSandboxOutput(text: string): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= CAPTURED_SANDBOX_OUTPUT_MAX_LENGTH) {
    return { text, truncated: false };
  }
  return {
    text:
      text.slice(0, CAPTURED_SANDBOX_OUTPUT_MAX_LENGTH) +
      CAPTURED_SANDBOX_OUTPUT_TRUNCATED_SUFFIX,
    truncated: true,
  };
}

function isSandboxExecTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|abort/i.test(message);
}

function isSandboxStreamEndedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  const stack = error instanceof Error ? error.stack ?? "" : "";
  return /stream ended before command finished|streamerror/i.test(
    `${name}\n${message}\n${stack}`,
  );
}

async function claimExistingWorkspaceSandbox(
  workspaceId: string,
  runId: string,
  statuses: SandboxStatus[],
  nextStatus: SandboxStatus,
): Promise<WorkspaceSandboxRow | null> {
  const candidate = await prisma.workspaceSandboxInstance.findFirst({
    where: { workspaceId, status: { in: statuses }, currentRunId: null },
    orderBy: { updatedAt: "desc" },
  });
  if (!candidate) return null;

  const result = await prisma.workspaceSandboxInstance.updateMany({
    where: {
      id: candidate.id,
      currentRunId: null,
      status: { in: statuses },
    },
    data: {
      currentRunId: runId,
      status: nextStatus,
      lastUsedAt: new Date(),
    },
  });
  if (result.count === 0) return null;
  return prisma.workspaceSandboxInstance.findUniqueOrThrow({
    where: { id: candidate.id },
  });
}

async function markSandboxReady(
  instanceId: string,
  sandbox: VercelSandboxHandle,
): Promise<void> {
  const state = sandbox.getState();
  await prisma.workspaceSandboxInstance.update({
    where: { id: instanceId },
    data: {
      status: "ready",
      provider: state.provider,
      sandboxName: state.sandboxName ?? undefined,
      snapshotId: state.snapshotId ?? undefined,
      workingDir: sandbox.workingDir,
      sandboxState: state,
      error: null,
      lastUsedAt: new Date(),
    },
  });
}

async function getVercelSandboxByName(
  sandboxName: string,
  timeoutMs?: number,
): Promise<VercelSandboxHandle> {
  const { getOrCreateSandbox } = await import("./factory.js");
  const result = await getOrCreateSandbox({
    sessionId: sandboxName.replace(/^cap-/, ""),
    timeoutMs,
  });
  return result.sandbox;
}

async function stopVercelSandboxByName(sandboxName: string): Promise<void> {
  const [{ Sandbox }, { resolveVercelCredentials }] = await Promise.all([
    import("@vercel/sandbox"),
    import("./vercel-credentials.js"),
  ]);
  const creds = resolveVercelCredentials();
  if (!creds) {
    throw new Error(
      "Vercel credentials not available: set VERCEL_TOKEN, or VERCEL_OIDC_TOKEN (+ optional VERCEL_TEAM_ID/VERCEL_PROJECT_ID).",
    );
  }
  const sandbox = await Sandbox.get({ name: sandboxName, ...creds });
  await sandbox.stop();
}

export const SCRIPTED_INGEST_RUNNER_SCRIPT = `
import fs from "node:fs/promises";

const forbidden = ["DATABASE_URL", "DIRECT_URL", "BETTER_AUTH_SECRET", "RUN_TOKEN_SECRET"];
const forbiddenEnvPresent = forbidden.some((key) => Boolean(process.env[key]));
const manifest = JSON.parse(await fs.readFile("scripted-ingest-runner-manifest.json", "utf8"));

async function post(path, body) {
  const response = await fetch(manifest.ingestBaseUrl + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + manifest.runToken
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(path + " -> " + response.status + " " + await response.text());
  }
}

await post("/api/ingest/heartbeat", { status: "running", phase: "boot" });
await post("/api/ingest/events", { seq: 1, type: "run_created", payload: null });
await post("/api/ingest/events", { seq: 2, type: "agent_started", payload: null });
await post("/api/ingest/tool-calls", {
  id: "vercel-fake-tool",
  eventSeq: 3,
  name: "fake_tool",
  status: "running",
  args: { provider: "vercel" }
});
await post("/api/ingest/tool-calls", {
  id: "vercel-fake-tool",
  eventSeq: 4,
  name: "fake_tool",
  status: "completed",
  args: { provider: "vercel" },
  result: { ok: true }
});
await post("/api/ingest/events", { seq: 5, type: "run_completed", payload: { durationMs: 1 } });

console.log(JSON.stringify({ insideSandbox: true, forbiddenEnvPresent }));
`.trim();

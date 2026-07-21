import { prisma } from "@cap/db";
import { buildPiRuntimeStartConfig } from "../pi-runtime/config.js";
import {
  getOrCreateWorkspaceSandbox,
  releaseWorkspaceSandboxForRun,
  startPiRuntimeInSandbox,
} from "../sandbox/workspace-sandbox.js";
import { issueRunToken } from "./run-token.js";
import { insertRunEvent } from "./event-store.js";
import { transitionRun } from "./transition-run.js";
import type { RunStatus } from "./transitions.js";
import {
  prepareWorkspaceFileSync,
  stageWorkspaceFileSync,
} from "../workspace-mapping/sync.js";

type WaitUntil = (promise: Promise<unknown>) => void;

export const DEFAULT_RUN_ORCHESTRATOR_API_BASE_URL =
  "https://api.sandbox.maidang.me";

export type RunOrchestrationResult =
  | { started: true; status: RunStatus }
  | { started: false; reason: string; status?: RunStatus };

export function shouldAutoStartRunner(): boolean {
  if (process.env.CAP_RUNNER_AUTO_START === "false") return false;
  if (
    process.env.NODE_ENV === "test" &&
    process.env.CAP_RUNNER_AUTO_START !== "true"
  ) {
    return false;
  }
  return true;
}

export function resolveRunOrchestratorApiBaseUrl(): string {
  const configured = [
    process.env.PUBLIC_AGENT_LOOP_BASE_URL,
    process.env.CAP_API_BASE_URL,
    process.env.INGEST_BASE_URL,
    process.env.API_BASE_URL,
    process.env.PUBLIC_API_BASE_URL,
    process.env.PUBLIC_INGEST_BASE_URL,
  ]
    .map((value) => publicHttpUrlOrNull(value))
    .find((value) => value !== null);

  return configured ?? DEFAULT_RUN_ORCHESTRATOR_API_BASE_URL;
}

function publicHttpUrlOrNull(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const isLocalhost =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1";
    if (isLocalhost || (url.protocol !== "http:" && url.protocol !== "https:")) {
      return null;
    }
    return value.replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function dispatchRunOrchestration(params: {
  runId: string;
  apiBaseUrl: string | null;
  waitUntil?: WaitUntil;
}): Promise<RunOrchestrationResult> {
  const promise = runCreatedRunOrchestration({
    runId: params.runId,
    apiBaseUrl: params.apiBaseUrl,
  }).catch(async (error): Promise<RunOrchestrationResult> => {
    await failRunBestEffort(
      params.runId,
      error instanceof Error ? error.message : String(error),
    );
    return { started: false, reason: "orchestration failed" };
  });

  params.waitUntil?.(promise);
  return promise;
}

export async function runCreatedRunOrchestration(params: {
  runId: string;
  apiBaseUrl: string | null;
}): Promise<RunOrchestrationResult> {
  if (!params.apiBaseUrl) {
    await failRunBestEffort(
      params.runId,
      "Public API base URL is required to start the sandbox runner.",
    );
    return { started: false, reason: "missing api base url", status: "failed" };
  }

  const run = await prisma.agentRun.findUnique({ where: { id: params.runId } });
  if (!run) return { started: false, reason: "run not found" };

  const currentStatus = run.status as RunStatus;
  if (currentStatus !== "created") {
    return { started: false, reason: "run is not created", status: currentStatus };
  }

  const provisioning = await transitionRun(run.id, "provisioning_sandbox", [
    "created",
  ]);
  if (!provisioning.applied) {
    const latest = await prisma.agentRun.findUnique({ where: { id: run.id } });
    if (latest?.status === "cancel_requested") {
      await finalizeCancelledRunBeforeRunner(run.id);
      return {
        started: false,
        reason: "run was cancelled before provisioning",
        status: "cancelled",
      };
    }
    return {
      started: false,
      reason: "run was claimed by another transition",
      status: latest?.status as RunStatus | undefined,
    };
  }

  const runToken = issueRunToken({
    userId: run.userId,
    workspaceId: run.workspaceId,
    threadId: run.threadId,
    runId: run.id,
    ttlSeconds: run.maxDurationSec + 600,
  });

  try {
    const claim = await getOrCreateWorkspaceSandbox({
      workspaceId: run.workspaceId,
      runId: run.id,
      timeoutMs: 60_000,
    });
    const workspaceSyncPlan = await prepareWorkspaceFileSync({
      workspaceId: run.workspaceId,
      syncedUpToRevision: claim.instance.syncedUpToRevision,
    });
    const syncStaged = await stageWorkspaceFileSync({
      instanceId: claim.instance.id,
      runId: run.id,
      targetRevision: workspaceSyncPlan.targetRevision,
    });
    if (!syncStaged) {
      throw new Error("Workspace file sync target could not be staged");
    }

    const running = await transitionRun(run.id, "running", [
      "provisioning_sandbox",
    ]);
    if (!running.applied) {
      await releaseWorkspaceSandboxForRun(run.id, "warm");
      const latest = await prisma.agentRun.findUnique({ where: { id: run.id } });
      if (latest?.status === "cancel_requested") {
        await finalizeCancelledRunBeforeRunner(run.id);
        return {
          started: false,
          reason: "run was cancelled before runner start",
          status: "cancelled",
        };
      }
      return {
        started: false,
        reason: "run left provisioning before runner start",
        status: latest?.status as RunStatus | undefined,
      };
    }

    await prisma.agentRun.updateMany({
      where: { id: run.id, status: "running", startedAt: null },
      data: { startedAt: new Date() },
    });

    await startPiRuntimeInSandbox({
      sandbox: claim.sandbox,
      config: buildPiRuntimeStartConfig({
        apiBaseUrl: params.apiBaseUrl,
        runToken,
        run: {
          id: run.id,
          workspaceId: run.workspaceId,
          threadId: run.threadId,
          userId: run.userId,
          prompt: run.prompt,
          maxDurationSec: run.maxDurationSec,
        },
        llmProvider: resolvePiRuntimeLlmProvider(),
        modelHint: process.env.CAP_PI_RUNTIME_MODEL_HINT ?? "pi-runtime",
        searchProvider: resolvePiRuntimeSearchProvider(),
        workspaceSyncPlan,
      }),
    });

    const latest = await prisma.agentRun.findUnique({ where: { id: run.id } });
    return {
      started: true,
      status: (latest?.status as RunStatus | undefined) ?? "running",
    };
  } catch (error) {
    await failRunBestEffort(
      run.id,
      error instanceof Error ? error.message : String(error),
    );
    return { started: false, reason: "runner start failed", status: "failed" };
  }
}

async function failRunBestEffort(runId: string, error: string): Promise<void> {
  await transitionRun(runId, "failed", [
    "created",
    "provisioning_sandbox",
    "running",
    "cancel_requested",
  ]).catch(() => undefined);
  await prisma.agentRun
    .updateMany({
      where: {
        id: runId,
        status: { in: ["failed", "timeout", "interrupted", "cancelled"] },
      },
      data: {
        error: trimRunError(error),
        completedAt: new Date(),
      },
    })
    .catch(() => undefined);
  await releaseWorkspaceSandboxForRun(runId, "failed").catch(() => undefined);
}

function trimRunError(error: string): string {
  return error.length > 1000 ? `${error.slice(0, 997)}...` : error;
}

function resolvePiRuntimeLlmProvider(): "fake" | "real" {
  return process.env.CAP_PI_RUNTIME_LLM_PROVIDER === "fake" ? "fake" : "real";
}

function resolvePiRuntimeSearchProvider(): "fake" | "http" | "exa" {
  const configured = process.env.CAP_PI_RUNTIME_SEARCH_PROVIDER;
  if (configured === "fake" || configured === "http" || configured === "exa") {
    return configured;
  }
  return process.env.EXA_API_KEY ? "exa" : "fake";
}

export async function finalizeCancelledRunBeforeRunner(
  runId: string,
): Promise<boolean> {
  const transition = await transitionRun(runId, "cancelled", [
    "cancel_requested",
  ]);
  if (!transition.applied) return false;

  await prisma.agentRun.update({
    where: { id: runId },
    data: { completedAt: new Date() },
  });
  const maxSeq = await prisma.runEvent.aggregate({
    where: { runId },
    _max: { seq: true },
  });
  const event = await insertRunEvent({
    runId,
    seq: (maxSeq._max.seq ?? 0) + 1,
    type: "run_cancelled",
    payload: null,
  });
  if (!event.ok) {
    throw new Error(`failed to record early cancellation: ${event.message}`);
  }
  return true;
}

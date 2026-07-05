import { Hono } from "hono";
import { Prisma, prisma, type RunToolCallStatus } from "@cap/db";
import {
  INGEST_SEQ_CONFLICT,
  VALIDATION_FAILED,
  insertRunEvent,
  isRunEventType,
  type RunEventInput,
} from "../run/event-store";
import { extractBearerRunToken, verifyRunToken } from "../run/run-token";
import { transitionRun } from "../run/transition-run";
import { isTerminalStatus, type RunStatus } from "../run/transitions";
import { releaseWorkspaceSandboxForRun } from "../sandbox/workspace-sandbox";
import {
  toWorkspaceFileDTO,
  upsertWorkspaceFile,
  validateWorkspaceFileInput,
} from "../files/store";

type AuthenticatedRun = {
  id: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  status: RunStatus;
};

const HEARTBEAT_PHASES = new Set([
  "boot",
  "load_context",
  "agent_loop",
  "finalize",
]);

const TOOL_CALL_STATUSES = new Set<RunToolCallStatus>([
  "pending",
  "running",
  "completed",
  "failed",
  "timeout",
  "rejected",
]);

const TERMINAL_TOOL_CALL_STATUSES = new Set<RunToolCallStatus>([
  "completed",
  "failed",
  "timeout",
  "rejected",
]);

export const ingestRoutes = new Hono();

ingestRoutes.post("/api/ingest/events", async (c) => {
  const body = await readJsonObject(c.req.raw);
  if (!body) {
    return c.json({ code: 1001, message: "bad request", data: null }, 400);
  }

  const run = await authenticateRunToken(c.req.header("authorization"), body);
  if (run instanceof Response) return run;

  const event = parseEventBody(body, run.id);
  if (!event.ok) {
    return c.json({ code: 1006, message: event.message, data: null }, 400);
  }

  if (isTerminalStatus(run.status)) {
    return c.json({ code: 2003, message: "run is terminal", data: null }, 409);
  }

  if (
    run.status === "waiting_for_input" &&
    event.input.type !== "run_waiting_for_input"
  ) {
    return c.json(
      { code: 2005, message: "run is not accepting events", data: null },
      409,
    );
  }

  if (event.input.type === "artifact_updated") {
    const artifactId = getArtifactId(event.input.payload);
    if (!artifactId || !(await hasExistingArtifactEvent(run.id, artifactId))) {
      return c.json(
        { code: 1006, message: "artifactId does not exist", data: null },
        400,
      );
    }
  }

  const result = await insertRunEvent(event.input);
  if (!result.ok) {
    if (result.code === INGEST_SEQ_CONFLICT) {
      return c.json({ code: 2004, message: result.message, data: null }, 409);
    }
    if (result.code === VALIDATION_FAILED) {
      return c.json({ code: 1006, message: result.message, data: null }, 400);
    }
    return c.json({ code: 5000, message: "internal error", data: null }, 500);
  }

  await applyRunEventSideEffects(run.id, event.input.type);

  return c.json({
    code: 0,
    message: "ok",
    data: { eventId: result.eventId, idempotent: result.idempotent },
  });
});

ingestRoutes.post("/api/ingest/heartbeat", async (c) => {
  const body = await readJsonObject(c.req.raw);
  if (!body) {
    return c.json({ code: 1001, message: "bad request", data: null }, 400);
  }

  const run = await authenticateRunToken(c.req.header("authorization"), body);
  if (run instanceof Response) return run;

  if (isTerminalStatus(run.status)) {
    return c.json({ code: 2003, message: "run is terminal", data: null }, 409);
  }
  if (run.status === "waiting_for_input") {
    return c.json(
      { code: 2005, message: "run is not accepting heartbeat", data: null },
      409,
    );
  }

  const phase = body.phase;
  if (
    phase !== undefined &&
    (typeof phase !== "string" || !HEARTBEAT_PHASES.has(phase))
  ) {
    return c.json({ code: 1006, message: "invalid phase", data: null }, 400);
  }
  if (body.status !== undefined && body.status !== "running") {
    return c.json({ code: 1006, message: "invalid status", data: null }, 400);
  }

  const updated = await prisma.agentRun.update({
    where: { id: run.id },
    data: {
      lastHeartbeatAt: new Date(),
      phase: phase ?? null,
    },
  });

  return c.json({
    code: 0,
    message: "ok",
    data: {
      run: {
        id: updated.id,
        lastHeartbeatAt: updated.lastHeartbeatAt?.toISOString(),
        phase: updated.phase ?? undefined,
      },
    },
  });
});

ingestRoutes.post("/api/ingest/tool-calls", async (c) => {
  const body = await readJsonObject(c.req.raw);
  if (!body) {
    return c.json({ code: 1001, message: "bad request", data: null }, 400);
  }

  const run = await authenticateRunToken(c.req.header("authorization"), body);
  if (run instanceof Response) return run;

  if (isTerminalStatus(run.status)) {
    return c.json({ code: 2003, message: "run is terminal", data: null }, 409);
  }
  if (run.status === "waiting_for_input") {
    return c.json(
      { code: 2005, message: "run is not accepting tool calls", data: null },
      409,
    );
  }

  const parsed = parseToolCallBody(body);
  if (!parsed.ok) {
    return c.json({ code: 1006, message: parsed.message, data: null }, 400);
  }

  const existing = await prisma.runToolCall.findUnique({
    where: { id: parsed.input.id },
  });
  if (existing && existing.runId !== run.id) {
    return c.json({ code: 2002, message: "run token invalid", data: null }, 401);
  }

  if (existing) {
    if (!isLegalToolCallTransition(existing.status, parsed.input.status)) {
      return c.json(
        { code: 2005, message: "invalid tool call transition", data: null },
        409,
      );
    }

    const updated = await prisma.runToolCall.update({
      where: { id: existing.id },
      data: {
        status: parsed.input.status,
        result: parsed.input.result as Prisma.InputJsonValue | undefined,
        error: parsed.input.error ?? null,
        completedAt: parsed.input.completedAt,
      },
    });
    return c.json({ code: 0, message: "ok", data: { toolCall: updated } });
  }

  if (!canCreateToolCallWithStatus(parsed.input.status)) {
    return c.json(
      { code: 2005, message: "invalid tool call transition", data: null },
      409,
    );
  }

  const created = await prisma.runToolCall.create({
    data: {
      id: parsed.input.id,
      workspaceId: run.workspaceId,
      runId: run.id,
      eventSeq: parsed.input.eventSeq,
      name: parsed.input.name,
      status: parsed.input.status,
      args: parsed.input.args as Prisma.InputJsonValue,
      result: parsed.input.result as Prisma.InputJsonValue | undefined,
      error: parsed.input.error ?? null,
      startedAt: parsed.input.startedAt,
      completedAt: parsed.input.completedAt,
    },
  });

  return c.json({ code: 0, message: "ok", data: { toolCall: created } });
});

ingestRoutes.post("/api/ingest/files", async (c) => {
  const body = await readJsonObject(c.req.raw);
  if (!body) {
    return c.json({ code: 1001, message: "bad request", data: null }, 400);
  }

  const run = await authenticateRunToken(c.req.header("authorization"), body);
  if (run instanceof Response) return run;

  if (isTerminalStatus(run.status)) {
    return c.json({ code: 2003, message: "run is terminal", data: null }, 409);
  }
  if (run.status === "waiting_for_input") {
    return c.json(
      { code: 2005, message: "run is not accepting files", data: null },
      409,
    );
  }

  const parsed = validateWorkspaceFileInput(body);
  if (!parsed.ok) {
    return c.json({ code: 1006, message: parsed.message, data: null }, 400);
  }

  const file = await upsertWorkspaceFile({
    workspaceId: run.workspaceId,
    runId: run.id,
    ...parsed.input,
  });

  return c.json({
    code: 0,
    message: "ok",
    data: { file: toWorkspaceFileDTO(file) },
  });
});

async function authenticateRunToken(
  authorizationHeader: string | undefined,
  body: Record<string, unknown>,
): Promise<AuthenticatedRun | Response> {
  const token = extractBearerRunToken(authorizationHeader);
  if (!token) {
    return jsonResponse(1002, "unauthorized", 401);
  }

  const bodyRunId = typeof body.runId === "string" ? body.runId : undefined;
  const verified = verifyRunToken(token, {
    expected: bodyRunId ? { runId: bodyRunId } : undefined,
  });
  if (!verified.ok) {
    return jsonResponse(2002, "run token invalid", 401);
  }

  const run = await prisma.agentRun.findUnique({
    where: { id: verified.claims.runId },
  });
  if (
    !run ||
    run.userId !== verified.claims.userId ||
    run.workspaceId !== verified.claims.workspaceId ||
    run.threadId !== verified.claims.threadId
  ) {
    return jsonResponse(2002, "run token invalid", 401);
  }

  return {
    id: run.id,
    workspaceId: run.workspaceId,
    threadId: run.threadId,
    userId: run.userId,
    status: run.status as RunStatus,
  };
}

function parseEventBody(
  body: Record<string, unknown>,
  runId: string,
):
  | { ok: true; input: RunEventInput }
  | { ok: false; message: string } {
  const seq = body.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq)) {
    return { ok: false, message: "seq must be an integer" };
  }
  if (typeof body.type !== "string" || !isRunEventType(body.type)) {
    return { ok: false, message: "unknown event type" };
  }

  const input: RunEventInput = {
    runId,
    seq,
    type: body.type,
    ...(typeof body.role === "string" ? { role: body.role } : {}),
    ...(typeof body.title === "string" ? { title: body.title } : {}),
    ...(typeof body.content === "string" ? { content: body.content } : {}),
    payload: body.payload as RunEventInput["payload"],
  };
  return { ok: true, input };
}

function getArtifactId(payload: unknown): string | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    !("artifactId" in payload) ||
    typeof payload.artifactId !== "string"
  ) {
    return null;
  }
  return payload.artifactId;
}

type ParsedToolCallBody =
  | {
      ok: true;
      input: {
        id: string;
        eventSeq: number;
        name: string;
        status: RunToolCallStatus;
        args: unknown;
        result?: unknown;
        error?: string;
        startedAt: Date;
        completedAt?: Date;
      };
    }
  | { ok: false; message: string };

function parseToolCallBody(body: Record<string, unknown>): ParsedToolCallBody {
  if (typeof body.id !== "string" || body.id.length === 0) {
    return { ok: false, message: "id is required" };
  }
  if (typeof body.eventSeq !== "number" || !Number.isInteger(body.eventSeq)) {
    return { ok: false, message: "eventSeq must be an integer" };
  }
  if (typeof body.name !== "string" || body.name.length === 0) {
    return { ok: false, message: "name is required" };
  }
  if (
    typeof body.status !== "string" ||
    !TOOL_CALL_STATUSES.has(body.status as RunToolCallStatus)
  ) {
    return { ok: false, message: "invalid tool call status" };
  }
  if (!Object.prototype.hasOwnProperty.call(body, "args")) {
    return { ok: false, message: "args is required" };
  }

  const status = body.status as RunToolCallStatus;
  if (status === "completed" && !Object.prototype.hasOwnProperty.call(body, "result")) {
    return { ok: false, message: "completed tool call requires result" };
  }
  if (
    (status === "failed" || status === "timeout" || status === "rejected") &&
    typeof body.error !== "string"
  ) {
    return { ok: false, message: `${status} tool call requires error` };
  }

  const startedAt = parseOptionalDate(body.startedAt) ?? new Date();
  const completedAt =
    parseOptionalDate(body.completedAt) ??
    (TERMINAL_TOOL_CALL_STATUSES.has(status) ? new Date() : undefined);

  return {
    ok: true,
    input: {
      id: body.id,
      eventSeq: body.eventSeq,
      name: body.name,
      status,
      args: body.args,
      ...(Object.prototype.hasOwnProperty.call(body, "result")
        ? { result: body.result }
        : {}),
      ...(typeof body.error === "string" ? { error: body.error } : {}),
      startedAt,
      ...(completedAt ? { completedAt } : {}),
    },
  };
}

function parseOptionalDate(value: unknown): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function canCreateToolCallWithStatus(status: RunToolCallStatus): boolean {
  return status === "pending" || status === "running" || status === "rejected";
}

function isLegalToolCallTransition(
  from: RunToolCallStatus,
  to: RunToolCallStatus,
): boolean {
  if (from === "pending") {
    return to === "running" || to === "rejected";
  }
  if (from === "running") {
    return (
      to === "completed" ||
      to === "failed" ||
      to === "timeout" ||
      to === "rejected"
    );
  }
  return false;
}

async function applyRunEventSideEffects(
  runId: string,
  type: RunEventInput["type"],
): Promise<void> {
  switch (type) {
    case "run_waiting_for_input":
      await transitionRun(runId, "waiting_for_input", ["running"]);
      await releaseWorkspaceSandboxForRun(runId, "warm");
      return;
    case "run_completed":
      await transitionRun(runId, "completed", ["running", "waiting_for_input"]);
      await releaseWorkspaceSandboxForRun(runId, "warm");
      return;
    case "run_failed":
      await transitionRun(runId, "failed", [
        "created",
        "provisioning_sandbox",
        "running",
        "cancel_requested",
      ]);
      await releaseWorkspaceSandboxForRun(runId, "warm");
      return;
    case "run_timeout":
      await transitionRun(runId, "timeout", [
        "provisioning_sandbox",
        "running",
        "cancel_requested",
      ]);
      await releaseWorkspaceSandboxForRun(runId, "warm");
      return;
    case "run_cancelled":
      await transitionRun(runId, "cancelled", ["cancel_requested"]);
      await releaseWorkspaceSandboxForRun(runId, "warm");
      return;
    default:
      return;
  }
}

async function hasExistingArtifactEvent(
  runId: string,
  artifactId: string,
): Promise<boolean> {
  const events = await prisma.runEvent.findMany({
    where: { runId, type: { in: ["artifact_created", "artifact_updated"] } },
    select: { raw: true },
  });
  return events.some((event) => {
    const raw = event.raw;
    return (
      typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw) &&
      "artifactId" in raw &&
      raw.artifactId === artifactId
    );
  });
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const parsed = await request.json().catch((): unknown => null);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function jsonResponse(code: number, message: string, status: 401): Response {
  return new Response(
    JSON.stringify({ code, message, data: null }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );
}

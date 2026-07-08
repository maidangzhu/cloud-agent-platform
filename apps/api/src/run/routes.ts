// Run 创建/查询/取消路由（见 docs/api-contract.md §5.4）。

import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { prisma } from "@cap/db";
import { requireUser } from "../require-user.js";
import { createRunIfThreadActive } from "./create.js";
import { cancelRun } from "./cancel.js";
import { validateRunPrompt } from "./validation.js";
import { deriveUiState } from "./derive-ui-state.js";
import { isTerminalStatus, type RunStatus } from "./transitions.js";
import { toArtifactDTO } from "../artifacts/store.js";
import { toSourceDTO } from "../sources/store.js";
import { readRunStream, type RunStreamEntry } from "../redis/streams.js";
import { extractBearerRunToken, verifyRunToken } from "./run-token.js";
import {
  dispatchRunOrchestration,
  resolveRunOrchestratorApiBaseUrl,
  shouldAutoStartRunner,
} from "./orchestrator.js";

type RunDTO = {
  id: string;
  workspaceId: string;
  threadId: string;
  status: RunStatus;
  prompt: string;
  derivedUiState: string;
  waitingForInput?: { question: string; options?: string[] };
  startedAt?: string;
  completedAt?: string;
  lastHeartbeatAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

function toDTO(
  row: {
    id: string;
    workspaceId: string;
    threadId: string;
    status: string;
    prompt: string;
    startedAt: Date | null;
    completedAt: Date | null;
    lastHeartbeatAt: Date | null;
    error: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  waitingForInput?: { question: string; options?: string[] },
): RunDTO {
  const status = row.status as RunStatus;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    threadId: row.threadId,
    status,
    prompt: row.prompt,
    derivedUiState: deriveUiState(
      status,
      row.lastHeartbeatAt,
      new Date(),
      row.createdAt,
    ),
    ...(waitingForInput ? { waitingForInput } : {}),
    ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
    ...(row.lastHeartbeatAt
      ? { lastHeartbeatAt: row.lastHeartbeatAt.toISOString() }
      : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type RunEventDTO = {
  seq: number;
  type: string;
  role?: string;
  title?: string;
  content?: string;
  payload: unknown;
  createdAt: string;
};

type StreamChunkDTO = {
  runId: string;
  streamType: RunStreamEntry["streamType"];
  chunk: string;
};

const SSE_POLL_INTERVAL_MS = 100;
const SSE_PING_INTERVAL_MS = 15_000;
const SSE_STREAM_READ_COUNT = 100;
const SSE_STREAM_DRAIN_MAX_BATCHES = 20;

function toEventDTO(row: {
  seq: number;
  type: string;
  role: string | null;
  title: string | null;
  content: string | null;
  raw: unknown;
  createdAt: Date;
}): RunEventDTO {
  return {
    seq: row.seq,
    type: row.type,
    role: row.role ?? undefined,
    title: row.title ?? undefined,
    content: row.content ?? undefined,
    payload: row.raw ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toStreamChunkDTO(runId: string, entry: RunStreamEntry): StreamChunkDTO {
  return {
    runId,
    streamType: entry.streamType,
    chunk: entry.chunk,
  };
}

function streamCursorFromLastEventId(value: string | undefined): string {
  const cursor = value?.trim();
  return cursor && /^\d+-\d+$/.test(cursor) ? cursor : "0";
}

function parseWaitingForInputPayload(
  payload: unknown,
): { question: string; options?: string[] } | undefined {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.question !== "string") return undefined;
  if (
    record.options !== undefined &&
    (!Array.isArray(record.options) ||
      !record.options.every((option) => typeof option === "string"))
  ) {
    return undefined;
  }
  return {
    question: record.question,
    ...(record.options ? { options: record.options as string[] } : {}),
  };
}

async function getWaitingForInput(runId: string) {
  const event = await prisma.runEvent.findFirst({
    where: { runId, type: "run_waiting_for_input" },
    orderBy: { seq: "desc" },
  });
  return event ? parseWaitingForInputPayload(event.raw) : undefined;
}

function shouldCloseSse(status: RunStatus): boolean {
  return isTerminalStatus(status) || status === "waiting_for_input";
}

export const runRoutes = new Hono();

runRoutes.post("/api/threads/:threadId/runs", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;

  const threadId = c.req.param("threadId");

  const body = await c.req
    .json<{ prompt?: string }>()
    .catch((): { prompt?: string } => ({}));
  const prompt = body.prompt ?? "";
  const validationError = validateRunPrompt(prompt);
  if (validationError) {
    return c.json({ code: 1006, message: validationError, data: null }, 400);
  }

  // 单条 insert-select 同时完成"thread 存在 + 属于当前用户 + thread/
  // workspace 都 active"的检查和写入（ADR-0018），0 行统一按 404 处理，
  // 不区分具体原因（同 Thread 创建路由的约定）。
  const result = await createRunIfThreadActive(threadId, prompt.trim(), user.id);
  if (!result.created) {
    return c.json({ code: 1004, message: "not found", data: null }, 404);
  }

  const created = await prisma.agentRun.findUniqueOrThrow({
    where: { id: result.runId },
  });

  if (shouldAutoStartRunner()) {
    void dispatchRunOrchestration({
      runId: created.id,
      apiBaseUrl: resolveRunOrchestratorApiBaseUrl(c.req.url),
      waitUntil: getWaitUntil(c),
    });
  }

  return c.json({ code: 0, message: "ok", data: { run: toDTO(created) } });
});

runRoutes.get("/api/runs/:runId", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;

  const runId = c.req.param("runId");
  if (!runId) {
    return c.json({ code: 1001, message: "runId is required", data: null }, 400);
  }
  const run = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (!run || run.userId !== user.id) {
    return c.json({ code: 1004, message: "not found", data: null }, 404);
  }

  const [events, toolCalls, artifacts, sources] = await Promise.all([
    prisma.runEvent.findMany({ where: { runId }, orderBy: { seq: "asc" } }),
    prisma.runToolCall.findMany({
      where: { runId },
      orderBy: { eventSeq: "asc" },
    }),
    prisma.workspaceArtifact.findMany({
      where: { runId },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.source.findMany({
      where: { runId },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return c.json({
    code: 0,
    message: "ok",
    data: {
      run: toDTO(run),
      events: events.map(toEventDTO),
      toolCalls: toolCalls.map((tc) => ({
        id: tc.id,
        runId: tc.runId,
        eventSeq: tc.eventSeq,
        name: tc.name,
        status: tc.status,
        args: tc.args,
        result: tc.result ?? undefined,
        error: tc.error ?? undefined,
        startedAt: tc.startedAt.toISOString(),
        completedAt: tc.completedAt?.toISOString(),
      })),
      artifacts: artifacts.map(toArtifactDTO),
      sources: sources.map(toSourceDTO),
    },
  });
});

runRoutes.get("/api/runs/:runId/control", async (c) => {
  const runId = c.req.param("runId");
  const token = extractBearerRunToken(c.req.header("authorization"));
  if (!token) {
    return c.json({ code: 1002, message: "unauthorized", data: null }, 401);
  }

  const verified = verifyRunToken(token, { expected: { runId } });
  if (verified.ok === false) {
    return c.json({ code: 2002, message: "run token invalid", data: null }, 401);
  }

  const run = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (
    !run ||
    run.userId !== verified.claims.userId ||
    run.workspaceId !== verified.claims.workspaceId ||
    run.threadId !== verified.claims.threadId
  ) {
    return c.json({ code: 2002, message: "run token invalid", data: null }, 401);
  }

  return c.json({
    code: 0,
    message: "ok",
    data: {
      runId: run.id,
      status: run.status,
      cancelRequested: run.status === "cancel_requested",
      terminal: isTerminalStatus(run.status as RunStatus),
      maxDurationSec: run.maxDurationSec,
      updatedAt: run.updatedAt.toISOString(),
    },
  });
});

async function handleRunEvents(c: Context) {
  const user = await requireUser(c);
  if (user instanceof Response) return user;

  const runId = c.req.param("runId");
  if (!runId) {
    return c.json({ code: 1001, message: "runId is required", data: null }, 400);
  }
  const run = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (!run || run.userId !== user.id) {
    return c.json({ code: 1004, message: "not found", data: null }, 404);
  }

  const body =
    c.req.raw.method === "POST"
      ? await c.req
          .json<{ lastEventId?: string }>()
          .catch((): { lastEventId?: string } => ({}))
      : {};
  const initialStreamCursor = streamCursorFromLastEventId(
    c.req.header("Last-Event-ID") ?? body.lastEventId,
  );

  return streamSSE(c, async (stream) => {
    const [snapshotEvents, waitingForInput] = await Promise.all([
      prisma.runEvent.findMany({ where: { runId }, orderBy: { seq: "asc" } }),
      getWaitingForInput(runId),
    ]);
    let lastSeq = snapshotEvents.at(-1)?.seq ?? 0;
    let streamCursor = initialStreamCursor;
    let currentRun = run;
    let currentStatus = currentRun.status as RunStatus;

    const forwardStreamEntries = async (entries: RunStreamEntry[]) => {
      for (const entry of entries) {
        streamCursor = entry.id;
        await stream.writeSSE({
          id: entry.id,
          event: "stream_chunk",
          data: JSON.stringify(toStreamChunkDTO(runId, entry)),
        });
      }
    };

    const drainAvailableStreamEntries = async () => {
      for (let i = 0; i < SSE_STREAM_DRAIN_MAX_BATCHES; i += 1) {
        const entries = await readRunStream({
          runId,
          cursor: streamCursor,
          blockMs: 1,
          count: SSE_STREAM_READ_COUNT,
        });
        await forwardStreamEntries(entries);
        if (entries.length < SSE_STREAM_READ_COUNT) return;
      }
    };

    await stream.writeSSE({
      event: "snapshot",
      data: JSON.stringify({
        run: toDTO(currentRun, waitingForInput),
        events: snapshotEvents.map(toEventDTO),
      }),
    });

    await drainAvailableStreamEntries();

    if (shouldCloseSse(currentStatus)) {
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({ runId, status: currentStatus }),
      });
      return;
    }

    let lastPingAt = Date.now();
    while (!stream.aborted && !c.req.raw.signal.aborted) {
      const [freshRun, newEvents, streamEntries] = await Promise.all([
        prisma.agentRun.findUnique({ where: { id: runId } }),
        prisma.runEvent.findMany({
          where: { runId, seq: { gt: lastSeq } },
          orderBy: { seq: "asc" },
        }),
        readRunStream({
          runId,
          cursor: streamCursor,
          blockMs: SSE_POLL_INTERVAL_MS,
          count: SSE_STREAM_READ_COUNT,
        }),
      ]);
      if (!freshRun) return;
      currentRun = freshRun;
      currentStatus = currentRun.status as RunStatus;

      await forwardStreamEntries(streamEntries);

      for (const event of newEvents) {
        lastSeq = event.seq;
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(toEventDTO(event)),
        });
      }

      if (shouldCloseSse(currentStatus)) {
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({ runId, status: currentStatus }),
        });
        return;
      }

      const now = Date.now();
      if (now - lastPingAt >= SSE_PING_INTERVAL_MS) {
        await stream.writeSSE({
          event: "ping",
          data: JSON.stringify({ now: new Date(now).toISOString() }),
        });
        lastPingAt = now;
      }
    }
  });
}

runRoutes.get("/api/runs/:runId/events", handleRunEvents);
runRoutes.post("/api/runs/:runId/events", handleRunEvents);

runRoutes.post("/api/runs/:runId/cancel", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;

  const runId = c.req.param("runId");
  const run = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (!run || run.userId !== user.id) {
    return c.json({ code: 1004, message: "not found", data: null }, 404);
  }

  const result = await cancelRun(runId);
  if (!result.applied) {
    return c.json(
      { code: 2001, message: "run is not cancelable", data: null },
      409,
    );
  }

  const updated = await prisma.agentRun.findUniqueOrThrow({
    where: { id: runId },
  });
  return c.json({ code: 0, message: "ok", data: { run: toDTO(updated) } });
});

function getWaitUntil(c: Context) {
  try {
    return (c as unknown as { executionCtx?: { waitUntil?: (p: Promise<unknown>) => void } })
      .executionCtx?.waitUntil;
  } catch {
    return undefined;
  }
}

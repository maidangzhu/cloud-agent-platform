// Run 创建/查询/取消路由（Step 6.3，见 docs/api-contract.md §5.4）。
//
// 这一步之后 run 会一直停在 created——还没有真实 sandbox（Group 9 才接
// fake runner），这是预期行为，不是 bug。

import { Hono } from "hono";
import { prisma } from "@cap/db";
import { requireUser } from "../require-user";
import { createRunIfThreadActive } from "./create";
import { cancelRun } from "./cancel";
import { validateRunPrompt } from "./validation";
import { deriveUiState } from "./derive-ui-state";
import type { RunStatus } from "./transitions";

type RunDTO = {
  id: string;
  workspaceId: string;
  threadId: string;
  status: RunStatus;
  prompt: string;
  derivedUiState: string;
  startedAt?: string;
  completedAt?: string;
  lastHeartbeatAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

function toDTO(row: {
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
}): RunDTO {
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

  return c.json({ code: 0, message: "ok", data: { run: toDTO(created) } });
});

runRoutes.get("/api/runs/:runId", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;

  const runId = c.req.param("runId");
  const run = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (!run || run.userId !== user.id) {
    return c.json({ code: 1004, message: "not found", data: null }, 404);
  }

  const [events, toolCalls] = await Promise.all([
    prisma.runEvent.findMany({ where: { runId }, orderBy: { seq: "asc" } }),
    prisma.runToolCall.findMany({
      where: { runId },
      orderBy: { eventSeq: "asc" },
    }),
  ]);

  return c.json({
    code: 0,
    message: "ok",
    data: {
      run: toDTO(run),
      events: events.map((e) => ({
        seq: e.seq,
        type: e.type,
        role: e.role ?? undefined,
        title: e.title ?? undefined,
        content: e.content ?? undefined,
        payload: e.raw ?? null,
        createdAt: e.createdAt.toISOString(),
      })),
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
      // Artifact/Source 表还没进入 v2 CRUD 阶段（Group 11/12），run detail
      // 的这两个字段暂时固定为空数组。
      artifacts: [],
      sources: [],
    },
  });
});

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

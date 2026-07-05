// Thread CRUD 路由（Step 5.1，见 docs/api-contract.md §5.3、
// docs/state-machines.md §4、ADR-0018 原子拒绝）。

import { Hono } from "hono";
import { prisma } from "@cap/db";
import { requireUser } from "../require-user";
import { createThreadIfWorkspaceActive } from "./create";
import { deriveThreadTitle } from "./title";
import { validateThreadTitle } from "./validation";

type ThreadDTO = {
  id: string;
  workspaceId: string;
  title: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
};

function toDTO(row: {
  id: string;
  workspaceId: string;
  title: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): ThreadDTO {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    status: row.status as "active" | "archived",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const threadRoutes = new Hono();

threadRoutes.get("/api/workspaces/:workspaceId/threads", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;

  const workspaceId = c.req.param("workspaceId");

  // 跨用户探测同 workspace 路由的约定：不存在/不是自己的 workspace 统一
  // 404，不区分（docs/testing-strategy.md §4.3 route 13）。
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
  });
  if (!workspace || workspace.ownerUserId !== user.id) {
    return c.json({ code: 1004, message: "not found", data: null }, 404);
  }

  const rows = await prisma.thread.findMany({
    where: { workspaceId },
    orderBy: { updatedAt: "desc" },
  });

  return c.json({ code: 0, message: "ok", data: { threads: rows.map(toDTO) } });
});

threadRoutes.post("/api/workspaces/:workspaceId/threads", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;

  const workspaceId = c.req.param("workspaceId");

  const body = await c.req
    .json<{ title?: string; initialPrompt?: string }>()
    .catch((): { title?: string; initialPrompt?: string } => ({}));
  const title = deriveThreadTitle(body.title, body.initialPrompt);

  // 单条 insert-select 同时完成"workspace 存在 + 属于当前用户 + active"
  // 三个条件的检查和 thread 写入（ADR-0018），0 行统一按 404 处理——不
  // 区分"workspace 不存在""是别人的""已归档"，同 workspace 路由的约定。
  const result = await createThreadIfWorkspaceActive(
    workspaceId,
    title,
    user.id,
  );
  if (!result.created) {
    return c.json({ code: 1004, message: "not found", data: null }, 404);
  }

  const created = await prisma.thread.findUniqueOrThrow({
    where: { id: result.threadId },
  });

  return c.json({ code: 0, message: "ok", data: { thread: toDTO(created) } });
});

threadRoutes.get("/api/threads/:threadId", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;

  const threadId = c.req.param("threadId");
  const thread = await prisma.thread.findUnique({ where: { id: threadId } });
  if (!thread) {
    return c.json({ code: 1004, message: "not found", data: null }, 404);
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: thread.workspaceId },
  });
  // 归档的 thread 仍可读（docs/state-machines.md §4），这里的 404 只针对
  // "不属于当前用户"，不针对 thread/workspace 的 active/archived 状态。
  if (!workspace || workspace.ownerUserId !== user.id) {
    return c.json({ code: 1004, message: "not found", data: null }, 404);
  }

  const messages = await prisma.threadMessage.findMany({
    where: { threadId },
    orderBy: { createdAt: "asc" },
  });

  return c.json({
    code: 0,
    message: "ok",
    data: {
      thread: toDTO(thread),
      messages: messages.map((m) => ({
        id: m.id,
        workspaceId: m.workspaceId,
        threadId: m.threadId,
        runId: m.runId ?? undefined,
        role: m.role as "user" | "assistant",
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      })),
      // Run 表还没进入 CRUD 阶段（Group 6），thread detail 的 runs 暂时
      // 固定为空数组，符合本 Step 验收标准。
      runs: [],
    },
  });
});

threadRoutes.patch("/api/threads/:threadId", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;

  const threadId = c.req.param("threadId");
  const existing = await prisma.thread.findUnique({ where: { id: threadId } });
  if (!existing) {
    return c.json({ code: 1004, message: "not found", data: null }, 404);
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: existing.workspaceId },
  });
  if (!workspace || workspace.ownerUserId !== user.id) {
    return c.json({ code: 1004, message: "not found", data: null }, 404);
  }

  const body = await c.req
    .json<{ title?: string; status?: "active" | "archived" }>()
    .catch((): { title?: string; status?: "active" | "archived" } => ({}));

  if (body.title !== undefined) {
    const validationError = validateThreadTitle(body.title);
    if (validationError) {
      return c.json({ code: 1006, message: validationError, data: null }, 400);
    }
  }
  if (body.status !== undefined && body.status !== "active" && body.status !== "archived") {
    return c.json(
      { code: 1006, message: "status must be active or archived", data: null },
      400,
    );
  }

  const updated = await prisma.thread.update({
    where: { id: threadId },
    data: {
      ...(body.title !== undefined ? { title: body.title.trim() } : {}),
      ...(body.status !== undefined
        ? {
            status: body.status,
            archivedAt: body.status === "archived" ? new Date() : null,
          }
        : {}),
    },
  });

  return c.json({ code: 0, message: "ok", data: { thread: toDTO(updated) } });
});

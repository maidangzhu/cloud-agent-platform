// Workspace CRUD 路由（Step 4.1，见 docs/api-contract.md §5.2、
// docs/state-machines.md §3、ADR-0018 原子拒绝）。

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { prisma } from "@cap/db";
import { requireUser } from "../require-user.js";
import { validateWorkspaceTitle } from "./validation.js";

type WorkspaceDTO = {
  id: string;
  title: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
};

function toDTO(row: {
  id: string;
  title: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): WorkspaceDTO {
  return {
    id: row.id,
    title: row.title,
    status: row.status as "active" | "archived",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const workspaceRoutes = new Hono();

const DEFAULT_WORKSPACE_TITLE = "Research workspace";

async function ensureWorkspace(ownerUserId: string, title: string) {
  return prisma.workspace.upsert({
    where: { ownerUserId },
    create: {
      id: randomUUID(),
      ownerUserId,
      title,
    },
    update: {},
  });
}

workspaceRoutes.get("/api/workspaces", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;

  const includeArchived = c.req.query("includeArchived") === "true";
  const workspace = await ensureWorkspace(user.id, DEFAULT_WORKSPACE_TITLE);
  const rows =
    includeArchived || workspace.status === "active" ? [workspace] : [];

  return c.json({
    code: 0,
    message: "ok",
    data: { workspaces: rows.map(toDTO) },
  });
});

workspaceRoutes.post("/api/workspaces", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;

  const body = await c.req
    .json<{ title?: string }>()
    .catch((): { title?: string } => ({}));
  const title = body.title ?? "";
  const validationError = validateWorkspaceTitle(title);
  if (validationError) {
    return c.json(
      { code: 1006, message: validationError, data: null },
      400,
    );
  }

  const created = await ensureWorkspace(user.id, title.trim());

  return c.json({ code: 0, message: "ok", data: { workspace: toDTO(created) } });
});

workspaceRoutes.get("/api/workspaces/:workspaceId", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;

  const workspaceId = c.req.param("workspaceId");
  const row = await prisma.workspace.findUnique({ where: { id: workspaceId } });

  // 跨用户读取：统一返回 404，不区分"不存在"和"是别人的"，避免探测出
  // workspace id 是否存在（docs/testing-strategy.md §4.2 route 14）。
  if (!row || row.ownerUserId !== user.id) {
    return c.json({ code: 1004, message: "not found", data: null }, 404);
  }

  return c.json({ code: 0, message: "ok", data: { workspace: toDTO(row) } });
});

workspaceRoutes.patch("/api/workspaces/:workspaceId", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;

  const workspaceId = c.req.param("workspaceId");
  const existing = await prisma.workspace.findUnique({
    where: { id: workspaceId },
  });
  if (!existing || existing.ownerUserId !== user.id) {
    return c.json({ code: 1004, message: "not found", data: null }, 404);
  }

  const body = await c.req
    .json<{ title?: string }>()
    .catch((): { title?: string } => ({}));
  if (body.title !== undefined) {
    const validationError = validateWorkspaceTitle(body.title);
    if (validationError) {
      return c.json(
        { code: 1006, message: validationError, data: null },
        400,
      );
    }
  }

  const updated = await prisma.workspace.update({
    where: { id: workspaceId },
    data: body.title !== undefined ? { title: body.title.trim() } : {},
  });

  return c.json({ code: 0, message: "ok", data: { workspace: toDTO(updated) } });
});

workspaceRoutes.delete("/api/workspaces/:workspaceId", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;

  const workspaceId = c.req.param("workspaceId");

  // P0 中 delete 表示 archive（docs/api-contract.md §5.2 规则）。
  // 用条件 UPDATE 而非"先查后改"，一并做归属校验：只有属于当前用户的
  // workspace 才能被这次 UPDATE 命中（ADR-0018 原子性原则的应用——
  // 这里的"条件"同时承担了鉴权和归档两个语义，不需要额外一次查询）。
  const result = await prisma.workspace.updateMany({
    where: { id: workspaceId, ownerUserId: user.id },
    data: { status: "archived", archivedAt: new Date() },
  });

  if (result.count === 0) {
    return c.json({ code: 1004, message: "not found", data: null }, 404);
  }

  return c.json({ code: 0, message: "ok", data: null });
});

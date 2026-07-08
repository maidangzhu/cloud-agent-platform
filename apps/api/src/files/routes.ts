import { Hono } from "hono";
import { prisma } from "@cap/db";
import { requireUser } from "../require-user.js";
import { normalizeWorkspacePath, toWorkspaceFileDTO } from "./store.js";

export const fileRoutes = new Hono();

fileRoutes.get("/api/workspaces/:workspaceId/files", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;

  const workspaceId = c.req.param("workspaceId");
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
  });
  if (!workspace) {
    return c.json({ code: 1004, message: "not found", data: null }, 404);
  }
  if (workspace.ownerUserId !== user.id) {
    return c.json({ code: 1003, message: "forbidden", data: null }, 403);
  }

  const files = await prisma.workspaceFile.findMany({
    where: { workspaceId },
    orderBy: { path: "asc" },
  });

  return c.json({
    code: 0,
    message: "ok",
    data: { files: files.map(toWorkspaceFileDTO) },
  });
});

fileRoutes.get("/api/workspaces/:workspaceId/files/content", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;

  const workspaceId = c.req.param("workspaceId");
  const normalized = normalizeWorkspacePath(c.req.query("path"));
  if (normalized.ok === false) {
    return c.json({ code: 1006, message: normalized.message, data: null }, 400);
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
  });
  if (!workspace) {
    return c.json({ code: 1004, message: "not found", data: null }, 404);
  }
  if (workspace.ownerUserId !== user.id) {
    return c.json({ code: 1003, message: "forbidden", data: null }, 403);
  }

  const file = await prisma.workspaceFile.findUnique({
    where: {
      workspaceId_path: {
        workspaceId,
        path: normalized.path,
      },
    },
  });
  if (!file) {
    return c.json({ code: 1004, message: "not found", data: null }, 404);
  }
  if (file.content === null) {
    return c.json(
      { code: 2006, message: "file content is not inline", data: null },
      409,
    );
  }

  return c.json({
    code: 0,
    message: "ok",
    data: { file: toWorkspaceFileDTO(file), content: file.content },
  });
});

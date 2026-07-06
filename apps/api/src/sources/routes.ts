import { Hono } from "hono";
import { prisma } from "@cap/db";
import { requireUser } from "../require-user";
import { toSourceDTO } from "./store";

export const sourceRoutes = new Hono();

sourceRoutes.get("/api/workspaces/:workspaceId/sources", async (c) => {
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

  const sources = await prisma.source.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
  });

  return c.json({
    code: 0,
    message: "ok",
    data: { sources: sources.map(toSourceDTO) },
  });
});

sourceRoutes.get("/api/runs/:runId/sources", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;

  const runId = c.req.param("runId");
  const run = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (!run) {
    return c.json({ code: 1004, message: "not found", data: null }, 404);
  }
  if (run.userId !== user.id) {
    return c.json({ code: 1003, message: "forbidden", data: null }, 403);
  }

  const sources = await prisma.source.findMany({
    where: { runId },
    orderBy: { createdAt: "desc" },
  });

  return c.json({
    code: 0,
    message: "ok",
    data: { sources: sources.map(toSourceDTO) },
  });
});

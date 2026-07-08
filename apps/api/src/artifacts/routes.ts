import { Hono } from "hono";
import { prisma } from "@cap/db";
import { requireUser } from "../require-user.js";
import {
  artifactDownloadPayload,
  toArtifactDTO,
  toArtifactVersionDTO,
} from "./store.js";
import { toSourceDTO } from "../sources/store.js";

export const artifactRoutes = new Hono();

type ArtifactWithWorkspace = Awaited<
  ReturnType<typeof prisma.workspaceArtifact.findUnique>
>;

artifactRoutes.get("/api/workspaces/:workspaceId/artifacts", async (c) => {
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

  const artifacts = await prisma.workspaceArtifact.findMany({
    where: { workspaceId },
    orderBy: { updatedAt: "desc" },
  });

  return c.json({
    code: 0,
    message: "ok",
    data: { artifacts: artifacts.map(toArtifactDTO) },
  });
});

artifactRoutes.get("/api/artifacts/:artifactId", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;

  const artifactId = c.req.param("artifactId");
  const artifact = await requireArtifactForUser(artifactId, user.id);
  if (artifact instanceof Response) return artifact;

  return c.json({
    code: 0,
    message: "ok",
    data: {
      artifact: toArtifactDTO(artifact),
      sources: (
        await prisma.source.findMany({
          where: { artifactId: artifact.id },
          orderBy: { createdAt: "desc" },
        })
      ).map(toSourceDTO),
    },
  });
});

artifactRoutes.get("/api/artifacts/:artifactId/versions", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;

  const artifactId = c.req.param("artifactId");
  const artifact = await requireArtifactForUser(artifactId, user.id);
  if (artifact instanceof Response) return artifact;

  const versions = await prisma.workspaceArtifactVersion.findMany({
    where: { artifactId },
    orderBy: { version: "asc" },
  });

  return c.json({
    code: 0,
    message: "ok",
    data: {
      versions:
        versions.length > 0
          ? versions.map(toArtifactVersionDTO)
          : [
              toArtifactVersionDTO({
                version: artifact.version,
                contentSnapshot: artifact.contentSnapshot,
                storageKey: artifact.storageKey,
                runId: artifact.runId,
                createdAt: artifact.createdAt,
              }),
            ],
    },
  });
});

artifactRoutes.get("/api/artifacts/:artifactId/download", async (c) => {
  const user = await requireUser(c);
  if (user instanceof Response) return user;

  const artifactId = c.req.param("artifactId");
  const artifact = await requireArtifactForUser(artifactId, user.id);
  if (artifact instanceof Response) return artifact;

  return c.json({
    code: 0,
    message: "ok",
    data: artifactDownloadPayload(artifact),
  });
});

async function requireArtifactForUser(
  artifactId: string,
  userId: string,
): Promise<NonNullable<ArtifactWithWorkspace> | Response> {
  const artifact = await prisma.workspaceArtifact.findUnique({
    where: { id: artifactId },
  });
  if (!artifact) {
    return jsonError(1004, "not found", 404);
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: artifact.workspaceId },
  });
  if (!workspace) {
    return jsonError(1004, "not found", 404);
  }
  if (workspace.ownerUserId !== userId) {
    return jsonError(1003, "forbidden", 403);
  }
  return artifact;
}

function jsonError(code: number, message: string, status: 403 | 404): Response {
  return new Response(JSON.stringify({ code, message, data: null }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

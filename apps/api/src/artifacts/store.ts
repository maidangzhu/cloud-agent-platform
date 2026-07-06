import { randomUUID } from "node:crypto";
import { prisma, type ArtifactKind } from "@cap/db";
import { normalizeWorkspacePath } from "../files/store";

const ARTIFACT_KINDS = new Set<ArtifactKind>([
  "text",
  "code",
  "sheet",
  "image",
]);

export type ParsedArtifactInput = {
  artifactId?: string;
  title: string;
  kind: ArtifactKind;
  path?: string;
  contentSnapshot?: string;
  storageKey?: string;
  eventSeq?: number;
};

export type ResolvedArtifactInput = ParsedArtifactInput & {
  contentSnapshot?: string;
  storageKey?: string;
};

export function allocateArtifactVersion(currentVersion: number | null): number {
  return currentVersion === null ? 1 : currentVersion + 1;
}

export function validateArtifactInput(
  input: Record<string, unknown>,
): { ok: true; input: ParsedArtifactInput } | { ok: false; message: string } {
  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    return { ok: false, message: "title is required" };
  }
  if (
    typeof input.kind !== "string" ||
    !ARTIFACT_KINDS.has(input.kind as ArtifactKind)
  ) {
    return { ok: false, message: "kind must be text, code, sheet, or image" };
  }

  const artifactId =
    typeof input.artifactId === "string" && input.artifactId.length > 0
      ? input.artifactId
      : undefined;
  const contentSnapshot =
    typeof input.contentSnapshot === "string" &&
    input.contentSnapshot.length > 0
      ? input.contentSnapshot
      : undefined;
  const storageKey =
    typeof input.storageKey === "string" && input.storageKey.length > 0
      ? input.storageKey
      : undefined;

  let normalizedPath: string | undefined;
  if (input.path !== undefined) {
    const normalized = normalizeWorkspacePath(input.path);
    if (!normalized.ok) return normalized;
    normalizedPath = normalized.path;
  }

  if (!contentSnapshot && !storageKey && !normalizedPath) {
    return {
      ok: false,
      message: "contentSnapshot, storageKey, or path is required",
    };
  }

  const eventSeq = input.eventSeq;
  if (
    eventSeq !== undefined &&
    (typeof eventSeq !== "number" || !Number.isInteger(eventSeq))
  ) {
    return { ok: false, message: "eventSeq must be an integer" };
  }

  return {
    ok: true,
    input: {
      ...(artifactId ? { artifactId } : {}),
      title: input.title.trim(),
      kind: input.kind as ArtifactKind,
      ...(normalizedPath ? { path: normalizedPath } : {}),
      ...(contentSnapshot ? { contentSnapshot } : {}),
      ...(storageKey ? { storageKey } : {}),
      ...(eventSeq !== undefined ? { eventSeq } : {}),
    },
  };
}

export function hasRecoverableArtifactContent(input: {
  contentSnapshot?: string;
  storageKey?: string;
  path?: string;
}): boolean {
  return Boolean(input.contentSnapshot || input.storageKey || input.path);
}

export async function resolveArtifactContentFromPath(params: {
  workspaceId: string;
  input: ParsedArtifactInput;
}): Promise<
  | { ok: true; input: ResolvedArtifactInput }
  | { ok: false; message: string }
> {
  if (params.input.contentSnapshot || params.input.storageKey) {
    return { ok: true, input: params.input };
  }
  if (!params.input.path) {
    return { ok: false, message: "recoverable content is required" };
  }

  const file = await prisma.workspaceFile.findUnique({
    where: {
      workspaceId_path: {
        workspaceId: params.workspaceId,
        path: params.input.path,
      },
    },
  });
  if (!file) {
    return { ok: false, message: "artifact path does not exist" };
  }
  if (file.content !== null) {
    return {
      ok: true,
      input: { ...params.input, contentSnapshot: file.content },
    };
  }
  if (file.storageKey !== null) {
    return {
      ok: true,
      input: { ...params.input, storageKey: file.storageKey },
    };
  }
  return { ok: false, message: "artifact path has no recoverable content" };
}

export async function createFirstArtifact(params: {
  workspaceId: string;
  threadId: string;
  runId: string;
  input: ResolvedArtifactInput;
}) {
  return prisma.$transaction(async (tx) => {
    const artifact = await tx.workspaceArtifact.create({
      data: {
        id: params.input.artifactId ?? randomUUID(),
        workspaceId: params.workspaceId,
        threadId: params.threadId,
        runId: params.runId,
        title: params.input.title,
        kind: params.input.kind,
        path: params.input.path,
        contentSnapshot: params.input.contentSnapshot,
        storageKey: params.input.storageKey,
        version: 1,
      },
    });
    await tx.workspaceArtifactVersion.create({
      data: {
        id: randomUUID(),
        artifactId: artifact.id,
        workspaceId: artifact.workspaceId,
        runId: artifact.runId,
        version: artifact.version,
        contentSnapshot: artifact.contentSnapshot,
        storageKey: artifact.storageKey,
      },
    });
    return artifact;
  });
}

export async function updateArtifactVersion(params: {
  artifactId: string;
  workspaceId: string;
  threadId: string;
  runId: string;
  input: ResolvedArtifactInput;
}) {
  return prisma.$transaction(async (tx) => {
    const artifact = await tx.workspaceArtifact.update({
      where: { id: params.artifactId, workspaceId: params.workspaceId },
      data: {
        threadId: params.threadId,
        runId: params.runId,
        title: params.input.title,
        kind: params.input.kind,
        path: params.input.path ?? null,
        contentSnapshot: params.input.contentSnapshot ?? null,
        storageKey: params.input.storageKey ?? null,
        version: { increment: 1 },
      },
    });
    await tx.workspaceArtifactVersion.create({
      data: {
        id: randomUUID(),
        artifactId: artifact.id,
        workspaceId: artifact.workspaceId,
        runId: artifact.runId,
        version: artifact.version,
        contentSnapshot: artifact.contentSnapshot,
        storageKey: artifact.storageKey,
      },
    });
    return artifact;
  });
}

export function toArtifactDTO(row: {
  id: string;
  workspaceId: string;
  threadId: string | null;
  runId: string;
  title: string;
  kind: string;
  path: string | null;
  contentSnapshot: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    threadId: row.threadId ?? undefined,
    runId: row.runId,
    title: row.title,
    kind: row.kind as ArtifactKind,
    path: row.path ?? undefined,
    contentSnapshot: row.contentSnapshot ?? undefined,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toArtifactVersionDTO(row: {
  version: number;
  contentSnapshot: string | null;
  storageKey: string | null;
  runId: string;
  createdAt: Date;
}) {
  return {
    version: row.version,
    contentSnapshot: row.contentSnapshot ?? undefined,
    storageKey: row.storageKey ?? undefined,
    createdByRunId: row.runId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function artifactDownloadPayload(row: {
  title: string;
  kind: string;
  contentSnapshot: string | null;
  storageKey: string | null;
}) {
  const filename = `${safeFilename(row.title)}.${extensionForKind(row.kind)}`;
  const mimeType = mimeTypeForKind(row.kind);
  if (row.contentSnapshot !== null) {
    return { filename, mimeType, content: row.contentSnapshot };
  }
  return {
    filename,
    mimeType,
    downloadUrl: `/api/storage/${encodeURIComponent(row.storageKey ?? "")}`,
  };
}

function safeFilename(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return normalized.replace(/^-+|-+$/g, "") || "artifact";
}

function extensionForKind(kind: string): string {
  switch (kind) {
    case "code":
      return "txt";
    case "sheet":
      return "csv";
    case "image":
      return "bin";
    default:
      return "md";
  }
}

function mimeTypeForKind(kind: string): string {
  switch (kind) {
    case "sheet":
      return "text/csv";
    case "image":
      return "application/octet-stream";
    default:
      return "text/plain";
  }
}

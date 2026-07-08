import { createHash, randomUUID } from "node:crypto";
import { posix as path } from "node:path";
import { prisma, type WorkspaceFileKind } from "@cap/db";

export const MAX_INLINE_FILE_CONTENT_BYTES = 1024 * 1024;

const FILE_KINDS = new Set<WorkspaceFileKind>(["text", "binary", "directory"]);

export type NormalizedWorkspacePathResult =
  | { ok: true; path: string }
  | { ok: false; message: string };

export type IngestWorkspaceFileInput = {
  workspaceId: string;
  runId: string;
  path: string;
  kind: WorkspaceFileKind;
  mimeType?: string;
  size: number;
  contentHash: string;
  content?: string;
  storageKey?: string;
};

export function normalizeWorkspacePath(
  value: unknown,
): NormalizedWorkspacePathResult {
  if (typeof value !== "string") {
    return { ok: false, message: "path is required" };
  }

  const raw = value.trim().replace(/\\/g, "/");
  if (raw.length === 0 || raw.includes("\0")) {
    return { ok: false, message: "path is invalid" };
  }
  if (path.isAbsolute(raw)) {
    return { ok: false, message: "path must be relative" };
  }

  const normalized = path.normalize(raw);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return { ok: false, message: "path escapes workspace root" };
  }

  return { ok: true, path: normalized };
}

export function computeContentHash(content: string | Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function contentByteLength(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

export function validateWorkspaceFileInput(
  input: Record<string, unknown>,
): { ok: true; input: Omit<IngestWorkspaceFileInput, "workspaceId" | "runId"> } | {
  ok: false;
  message: string;
} {
  const normalized = normalizeWorkspacePath(input.path);
  if (normalized.ok === false) return normalized;

  if (
    typeof input.kind !== "string" ||
    !FILE_KINDS.has(input.kind as WorkspaceFileKind)
  ) {
    return { ok: false, message: "kind must be text, binary, or directory" };
  }

  if (
    typeof input.size !== "number" ||
    !Number.isInteger(input.size) ||
    input.size < 0
  ) {
    return { ok: false, message: "size must be a non-negative integer" };
  }

  if (typeof input.contentHash !== "string" || input.contentHash.length === 0) {
    return { ok: false, message: "contentHash is required" };
  }

  const kind = input.kind as WorkspaceFileKind;
  const content = typeof input.content === "string" ? input.content : undefined;
  const storageKey =
    typeof input.storageKey === "string" && input.storageKey.length > 0
      ? input.storageKey
      : undefined;
  const mimeType =
    typeof input.mimeType === "string" && input.mimeType.length > 0
      ? input.mimeType
      : undefined;

  if (kind === "directory") {
    if (input.size !== 0) {
      return { ok: false, message: "directory size must be 0" };
    }
    if (content !== undefined || storageKey !== undefined) {
      return {
        ok: false,
        message: "directory cannot include content or storageKey",
      };
    }
    return {
      ok: true,
      input: {
        path: normalized.path,
        kind,
        ...(mimeType ? { mimeType } : {}),
        size: input.size,
        contentHash: input.contentHash,
      },
    };
  }

  if (content === undefined && storageKey === undefined) {
    return { ok: false, message: "content or storageKey is required" };
  }

  if (content !== undefined) {
    const byteLength = contentByteLength(content);
    if (byteLength > MAX_INLINE_FILE_CONTENT_BYTES && storageKey === undefined) {
      return {
        ok: false,
        message: "inline content exceeds limit; storageKey is required",
      };
    }
    if (input.size !== byteLength) {
      return { ok: false, message: "size does not match content length" };
    }
    if (input.contentHash !== computeContentHash(content)) {
      return { ok: false, message: "contentHash does not match content" };
    }
  }

  return {
    ok: true,
    input: {
      path: normalized.path,
      kind,
      ...(mimeType ? { mimeType } : {}),
      size: input.size,
      contentHash: input.contentHash,
      ...(content !== undefined &&
      contentByteLength(content) <= MAX_INLINE_FILE_CONTENT_BYTES
        ? { content }
        : {}),
      ...(storageKey ? { storageKey } : {}),
    },
  };
}

export async function upsertWorkspaceFile(input: IngestWorkspaceFileInput) {
  return prisma.workspaceFile.upsert({
    where: {
      workspaceId_path: {
        workspaceId: input.workspaceId,
        path: input.path,
      },
    },
    create: {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      path: input.path,
      kind: input.kind,
      mimeType: input.mimeType,
      size: input.size,
      contentHash: input.contentHash,
      content: input.content,
      storageKey: input.storageKey,
      latestRunId: input.runId,
    },
    update: {
      kind: input.kind,
      mimeType: input.mimeType ?? null,
      size: input.size,
      contentHash: input.contentHash,
      content: input.content ?? null,
      storageKey: input.storageKey ?? null,
      latestRunId: input.runId,
    },
  });
}

export function toWorkspaceFileDTO(row: {
  id: string;
  workspaceId: string;
  path: string;
  kind: string;
  mimeType: string | null;
  size: number;
  contentHash: string;
  latestRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    path: row.path,
    kind: row.kind as WorkspaceFileKind,
    mimeType: row.mimeType ?? undefined,
    size: row.size,
    contentHash: row.contentHash,
    latestRunId: row.latestRunId ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

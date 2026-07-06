import { randomUUID } from "node:crypto";
import { Prisma, prisma, type SourceKind } from "@cap/db";

const SOURCE_KINDS = new Set<SourceKind>([
  "url",
  "file",
  "command",
  "search_result",
  "manual",
]);

export type ParsedSourceInput = {
  kind: SourceKind;
  uri?: string;
  title?: string;
  contentHash?: string;
  metadata?: unknown;
  artifactId?: string;
  eventSeq?: number;
};

export function validateSourceInput(
  input: Record<string, unknown>,
): { ok: true; input: ParsedSourceInput } | { ok: false; message: string } {
  if (
    typeof input.kind !== "string" ||
    !SOURCE_KINDS.has(input.kind as SourceKind)
  ) {
    return {
      ok: false,
      message: "kind must be url, file, command, search_result, or manual",
    };
  }

  const kind = input.kind as SourceKind;
  let uri: string | undefined;
  if (input.uri !== undefined) {
    if (typeof input.uri !== "string" || input.uri.trim().length === 0) {
      return { ok: false, message: "uri must be a non-empty string" };
    }
    try {
      uri =
        kind === "url" || kind === "search_result"
          ? normalizeSourceUrl(input.uri)
          : input.uri.trim();
    } catch {
      return { ok: false, message: "uri must be a valid URL" };
    }
  }

  if ((kind === "url" || kind === "search_result") && !uri) {
    return { ok: false, message: `${kind} source requires uri` };
  }

  const title =
    typeof input.title === "string" && input.title.trim().length > 0
      ? input.title.trim()
      : undefined;
  const contentHash =
    typeof input.contentHash === "string" && input.contentHash.length > 0
      ? input.contentHash
      : undefined;
  const artifactId =
    typeof input.artifactId === "string" && input.artifactId.length > 0
      ? input.artifactId
      : undefined;

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
      kind,
      ...(uri ? { uri } : {}),
      ...(title ? { title } : {}),
      ...(contentHash ? { contentHash } : {}),
      ...(Object.prototype.hasOwnProperty.call(input, "metadata")
        ? { metadata: input.metadata }
        : {}),
      ...(artifactId ? { artifactId } : {}),
      ...(eventSeq !== undefined ? { eventSeq } : {}),
    },
  };
}

export function normalizeSourceUrl(value: string): string {
  const url = new URL(value.trim());
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  const normalized = url.toString();
  return normalized.endsWith("/") && url.pathname === "/"
    ? normalized.slice(0, -1)
    : normalized;
}

export async function createSource(params: {
  workspaceId: string;
  runId: string;
  input: ParsedSourceInput;
}) {
  return prisma.source.create({
    data: {
      id: randomUUID(),
      workspaceId: params.workspaceId,
      runId: params.runId,
      artifactId: params.input.artifactId,
      kind: params.input.kind,
      uri: params.input.uri,
      title: params.input.title,
      contentHash: params.input.contentHash,
      metadata:
        params.input.metadata === undefined
          ? undefined
          : (params.input.metadata as Prisma.InputJsonValue),
    },
  });
}

export function toSourceDTO(row: {
  id: string;
  workspaceId: string;
  runId: string | null;
  artifactId: string | null;
  kind: string;
  uri: string | null;
  title: string | null;
  contentHash: string | null;
  metadata: unknown;
  createdAt: Date;
}) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    runId: row.runId ?? undefined,
    artifactId: row.artifactId ?? undefined,
    kind: row.kind as SourceKind,
    uri: row.uri ?? undefined,
    title: row.title ?? undefined,
    contentHash: row.contentHash ?? undefined,
    metadata: row.metadata ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

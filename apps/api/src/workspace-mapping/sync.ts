import { prisma } from "@cap/db";

export type WorkspaceFileSyncEntry = {
  path: string;
  kind: "text" | "directory";
  content?: string;
  isDeleted: boolean;
  revision: string;
};

export type WorkspaceFileSyncPlan = {
  fromRevision: string | null;
  targetRevision: string;
  filesToSync: WorkspaceFileSyncEntry[];
};

export async function prepareWorkspaceFileSync(params: {
  workspaceId: string;
  syncedUpToRevision: bigint | null;
}): Promise<WorkspaceFileSyncPlan> {
  return prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.findUniqueOrThrow({
      where: { id: params.workspaceId },
      select: { fileRevision: true },
    });
    const rows = await tx.workspaceFile.findMany({
      where: {
        workspaceId: params.workspaceId,
        revision: {
          ...(params.syncedUpToRevision !== null
            ? { gt: params.syncedUpToRevision }
            : {}),
          lte: workspace.fileRevision,
        },
      },
      orderBy: [{ revision: "asc" }, { path: "asc" }],
    });

    return {
      fromRevision: params.syncedUpToRevision?.toString() ?? null,
      targetRevision: workspace.fileRevision.toString(),
      filesToSync: rows.map(toSyncEntry),
    };
  });
}

export async function stageWorkspaceFileSync(params: {
  instanceId: string;
  runId: string;
  targetRevision: string;
}): Promise<boolean> {
  const targetRevision = BigInt(params.targetRevision);
  const result = await prisma.workspaceSandboxInstance.updateMany({
    where: {
      id: params.instanceId,
      currentRunId: params.runId,
    },
    data: { pendingSyncRevision: targetRevision },
  });
  return result.count === 1;
}

export async function markWorkspaceFileSyncCompleteForRun(
  runId: string,
): Promise<boolean> {
  const instance = await prisma.workspaceSandboxInstance.findFirst({
    where: { currentRunId: runId },
    select: { id: true, pendingSyncRevision: true },
  });
  if (!instance || instance.pendingSyncRevision === null) return false;

  const result = await prisma.workspaceSandboxInstance.updateMany({
    where: {
      id: instance.id,
      currentRunId: runId,
      pendingSyncRevision: instance.pendingSyncRevision,
    },
    data: {
      syncedUpToRevision: instance.pendingSyncRevision,
      pendingSyncRevision: null,
    },
  });
  return result.count === 1;
}

function toSyncEntry(row: {
  path: string;
  kind: string;
  content: string | null;
  storageKey: string | null;
  isDeleted: boolean;
  revision: bigint;
}): WorkspaceFileSyncEntry {
  if (row.isDeleted) {
    return {
      path: row.path,
      kind: row.kind === "directory" ? "directory" : "text",
      isDeleted: true,
      revision: row.revision.toString(),
    };
  }
  if (row.kind === "directory") {
    return {
      path: row.path,
      kind: "directory",
      isDeleted: false,
      revision: row.revision.toString(),
    };
  }
  if (row.kind !== "text" || row.content === null) {
    const location = row.storageKey ? `storageKey ${row.storageKey}` : "no content";
    throw new Error(
      `Workspace file ${row.path} cannot be hydrated inline (${location})`,
    );
  }
  return {
    path: row.path,
    kind: "text",
    content: row.content,
    isDeleted: false,
    revision: row.revision.toString(),
  };
}

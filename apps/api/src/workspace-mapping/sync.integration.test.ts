import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cap/db";
import {
  computeContentHash,
  markWorkspaceFileDeleted,
  upsertWorkspaceFile,
} from "../files/store.js";
import {
  markWorkspaceFileSyncCompleteForRun,
  prepareWorkspaceFileSync,
  stageWorkspaceFileSync,
} from "./sync.js";

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("Workspace revision mapping", () => {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const userId = `it-map-user-${suffix}`;
  const workspaceId = `it-map-workspace-${suffix}`;
  const threadId = `it-map-thread-${suffix}`;
  const firstRunId = `it-map-run-1-${suffix}`;
  const secondRunId = `it-map-run-2-${suffix}`;
  const instanceId = `it-map-sandbox-${suffix}`;

  afterAll(async () => {
    await prisma.workspaceSandboxInstance.deleteMany({ where: { id: instanceId } });
    await prisma.workspaceFile.deleteMany({ where: { workspaceId } });
    await prisma.agentRun.deleteMany({ where: { id: { in: [firstRunId, secondRunId] } } });
    await prisma.thread.deleteMany({ where: { id: threadId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("hydrates cold state, then emits only overwrite/delete revisions", async () => {
    await prisma.user.create({
      data: { id: userId, email: `${userId}@example.com`, name: "Mapping Test" },
    });
    await prisma.workspace.create({
      data: { id: workspaceId, ownerUserId: userId, title: "Mapping Test" },
    });
    await prisma.thread.create({
      data: { id: threadId, workspaceId, title: "Mapping Thread" },
    });
    for (const runId of [firstRunId, secondRunId]) {
      await prisma.agentRun.create({
        data: {
          id: runId,
          workspaceId,
          threadId,
          userId,
          prompt: "mapping",
          status: "running",
        },
      });
    }

    await writeText(firstRunId, "notes/preloaded.md", "version one");
    await writeText(firstRunId, "notes/delete-me.md", "remove me");
    await prisma.workspaceSandboxInstance.create({
      data: {
        id: instanceId,
        workspaceId,
        sandboxName: `cap-${instanceId}`,
        status: "ready",
        currentRunId: secondRunId,
      },
    });

    const cold = await prepareWorkspaceFileSync({
      workspaceId,
      syncedUpToRevision: null,
    });
    expect(cold).toMatchObject({
      fromRevision: null,
      targetRevision: "2",
    });
    expect(cold.filesToSync.map((file) => file.path)).toEqual([
      "notes/preloaded.md",
      "notes/delete-me.md",
    ]);
    expect(await stageWorkspaceFileSync({
      instanceId,
      runId: secondRunId,
      targetRevision: cold.targetRevision,
    })).toBe(true);
    expect(await markWorkspaceFileSyncCompleteForRun(secondRunId)).toBe(true);

    await writeText(secondRunId, "notes/preloaded.md", "version two");
    await markWorkspaceFileDeleted({
      workspaceId,
      path: "notes/delete-me.md",
    });
    const warm = await prepareWorkspaceFileSync({
      workspaceId,
      syncedUpToRevision: 2n,
    });
    expect(warm.targetRevision).toBe("4");
    expect(warm.filesToSync).toEqual([
      expect.objectContaining({
        path: "notes/preloaded.md",
        content: "version two",
        isDeleted: false,
        revision: "3",
      }),
      expect.objectContaining({
        path: "notes/delete-me.md",
        isDeleted: true,
        revision: "4",
      }),
    ]);

    const [concurrentA, concurrentB] = await Promise.all([
      writeText(secondRunId, "notes/concurrent-a.md", "A"),
      writeText(secondRunId, "notes/concurrent-b.md", "B"),
    ]);
    expect(new Set([
      concurrentA.revision.toString(),
      concurrentB.revision.toString(),
    ]).size).toBe(2);
    expect(concurrentA.revision).toBeGreaterThan(4n);
    expect(concurrentB.revision).toBeGreaterThan(4n);
    const concurrentTarget =
      concurrentA.revision > concurrentB.revision
        ? concurrentA.revision
        : concurrentB.revision;

    await upsertWorkspaceFile({
      workspaceId,
      runId: secondRunId,
      path: "reports/external.pdf",
      kind: "binary",
      mimeType: "application/pdf",
      size: 10,
      contentHash: `sha256:${"a".repeat(64)}`,
      storageKey: "workspaces/reports/external.pdf",
    });
    await expect(prepareWorkspaceFileSync({
      workspaceId,
      syncedUpToRevision: concurrentTarget,
    })).rejects.toThrow("cannot be hydrated inline");
  });

  async function writeText(runId: string, path: string, content: string) {
    return upsertWorkspaceFile({
      workspaceId,
      runId,
      path,
      kind: "text",
      mimeType: "text/markdown",
      size: Buffer.byteLength(content),
      contentHash: computeContentHash(content),
      content,
    });
  }
});

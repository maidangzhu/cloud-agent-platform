import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cap/db";
import { createApp } from "../app.js";
import { issueRunToken } from "../run/run-token.js";
import {
  MAX_INLINE_FILE_CONTENT_BYTES,
  computeContentHash,
  markWorkspaceFileDeleted,
} from "./store.js";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const HAS_SECRET = Boolean(process.env.BETTER_AUTH_SECRET);

async function signUpAndGetCookie(
  app: ReturnType<typeof createApp>,
  email: string,
): Promise<string> {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "integration-test-password-789",
      name: "Workspace File Test User",
    }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("sign-up did not set a session cookie");
  return cookie;
}

describe.skipIf(!HAS_DB || !HAS_SECRET)(
  "Workspace file routes（真实 Neon，见 Step 10.1）",
  () => {
    const app = createApp();
    const userEmail = `it-files-${Date.now()}@example.com`;
    const otherUserEmail = `it-files-other-${Date.now()}@example.com`;
    let cookie = "";
    let otherCookie = "";
    let workspaceId = "";
    let threadId = "";

    afterAll(async () => {
      const workspaces = await prisma.workspace.findMany({
        where: { title: { startsWith: "IT-FilesWs-" } },
      });
      const workspaceIds = workspaces.map((w) => w.id);
      if (workspaceIds.length > 0) {
        const threads = await prisma.thread.findMany({
          where: { workspaceId: { in: workspaceIds } },
        });
        const threadIds = threads.map((t) => t.id);
        const runs = await prisma.agentRun.findMany({
          where: { threadId: { in: threadIds } },
        });
        const runIds = runs.map((r) => r.id);
        if (runIds.length > 0) {
          await prisma.runToolCall.deleteMany({
            where: { runId: { in: runIds } },
          });
          await prisma.runEvent.deleteMany({
            where: { runId: { in: runIds } },
          });
          await prisma.agentRun.deleteMany({
            where: { id: { in: runIds } },
          });
        }
        await prisma.workspaceFile.deleteMany({
          where: { workspaceId: { in: workspaceIds } },
        });
        await prisma.thread.deleteMany({ where: { id: { in: threadIds } } });
        await prisma.workspace.deleteMany({
          where: { id: { in: workspaceIds } },
        });
      }
      await prisma.user.deleteMany({
        where: { email: { in: [userEmail, otherUserEmail] } },
      });
      await prisma.$disconnect();
    });

    async function createRun(prompt: string) {
      const res = await app.request(`/api/threads/${threadId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ prompt }),
      });
      expect(res.status).toBe(200);
      const runId = (await res.json()).data.run.id as string;
      return prisma.agentRun.update({
        where: { id: runId },
        data: { status: "running" },
      });
    }

    function tokenFor(run: {
      id: string;
      userId: string;
      workspaceId: string;
      threadId: string;
    }) {
      return issueRunToken({
        userId: run.userId,
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        runId: run.id,
      });
    }

    async function ingestFile(
      run: Awaited<ReturnType<typeof createRun>>,
      body: Record<string, unknown>,
    ) {
      return app.request("/api/ingest/files", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${tokenFor(run)}`,
        },
        body: JSON.stringify(body),
      });
    }

    it("准备：注册用户，建 workspace + thread", async () => {
      cookie = await signUpAndGetCookie(app, userEmail);
      otherCookie = await signUpAndGetCookie(app, otherUserEmail);

      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ title: "IT-FilesWs-Main" }),
      });
      workspaceId = (await wsRes.json()).data.workspace.id;

      const threadRes = await app.request(
        `/api/workspaces/${workspaceId}/threads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ title: "IT-FilesThread" }),
        },
      );
      threadId = (await threadRes.json()).data.thread.id;

      expect(workspaceId).toBeTruthy();
      expect(threadId).toBeTruthy();
      expect(otherCookie).toBeTruthy();
    });

    it("ingests file metadata with storageKey", async () => {
      const run = await createRun("file metadata");
      const res = await ingestFile(run, {
        path: "reports/report.pdf",
        kind: "binary",
        mimeType: "application/pdf",
        size: 4096,
        contentHash: "sha256:" + "a".repeat(64),
        storageKey: "workspaces/reports/report.pdf",
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.file.path).toBe("reports/report.pdf");
      expect(body.data.file.kind).toBe("binary");
      expect(body.data.file.latestRunId).toBe(run.id);
    });

    it("ingests small text content inline", async () => {
      const run = await createRun("small text file");
      const content = "hello from workspace file";
      const res = await ingestFile(run, {
        path: "./notes//research.md",
        kind: "text",
        mimeType: "text/markdown",
        size: Buffer.byteLength(content, "utf8"),
        contentHash: computeContentHash(content),
        content,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.file.path).toBe("notes/research.md");

      const row = await prisma.workspaceFile.findUnique({
        where: {
          workspaceId_path: {
            workspaceId,
            path: "notes/research.md",
          },
        },
      });
      expect(row?.content).toBe(content);
    });

    it("large content requires storageKey", async () => {
      const run = await createRun("large text file");
      const content = "x".repeat(MAX_INLINE_FILE_CONTENT_BYTES + 1);
      const rejected = await ingestFile(run, {
        path: "notes/large.md",
        kind: "text",
        size: Buffer.byteLength(content, "utf8"),
        contentHash: computeContentHash(content),
        content,
      });
      expect(rejected.status).toBe(400);

      const accepted = await ingestFile(run, {
        path: "notes/large.md",
        kind: "text",
        size: Buffer.byteLength(content, "utf8"),
        contentHash: computeContentHash(content),
        content,
        storageKey: "workspaces/notes/large.md",
      });
      expect(accepted.status).toBe(200);
      const row = await prisma.workspaceFile.findUnique({
        where: {
          workspaceId_path: {
            workspaceId,
            path: "notes/large.md",
          },
        },
      });
      expect(row?.content).toBeNull();
      expect(row?.storageKey).toBe("workspaces/notes/large.md");
    });

    it("rejects path traversal", async () => {
      const run = await createRun("path traversal");
      const content = "secret";
      const res = await ingestFile(run, {
        path: "../secret.txt",
        kind: "text",
        size: Buffer.byteLength(content, "utf8"),
        contentHash: computeContentHash(content),
        content,
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe(1006);
    });

    it("upserts by workspaceId and path", async () => {
      const firstRun = await createRun("upsert first");
      const firstContent = "first";
      const first = await ingestFile(firstRun, {
        path: "notes/upsert.md",
        kind: "text",
        size: Buffer.byteLength(firstContent, "utf8"),
        contentHash: computeContentHash(firstContent),
        content: firstContent,
      });
      expect(first.status).toBe(200);
      const firstFile = (await first.json()).data.file;
      const firstFileId = firstFile.id;
      const firstRevision = BigInt(firstFile.revision);

      const secondRun = await createRun("upsert second");
      const secondContent = "second";
      const second = await ingestFile(secondRun, {
        path: "notes/upsert.md",
        kind: "text",
        size: Buffer.byteLength(secondContent, "utf8"),
        contentHash: computeContentHash(secondContent),
        content: secondContent,
      });
      expect(second.status).toBe(200);
      const secondFile = (await second.json()).data.file;

      expect(secondFile.id).toBe(firstFileId);
      expect(secondFile.latestRunId).toBe(secondRun.id);
      expect(BigInt(secondFile.revision)).toBeGreaterThan(firstRevision);
      const count = await prisma.workspaceFile.count({
        where: { workspaceId, path: "notes/upsert.md" },
      });
      expect(count).toBe(1);
    });

    it("lists files in workspace", async () => {
      const res = await app.request(`/api/workspaces/${workspaceId}/files`, {
        headers: { cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      const paths = body.data.files.map((file: { path: string }) => file.path);
      expect(paths).toContain("notes/research.md");
      expect(paths).toContain("notes/upsert.md");
      expect(paths).toContain("reports/report.pdf");
    });

    it("reads file content by path", async () => {
      const res = await app.request(
        `/api/workspaces/${workspaceId}/files/content?path=notes/research.md`,
        { headers: { cookie } },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.file.path).toBe("notes/research.md");
      expect(body.data.content).toBe("hello from workspace file");
    });

    it("rejects another user's workspace file access", async () => {
      const res = await app.request(`/api/workspaces/${workspaceId}/files`, {
        headers: { cookie: otherCookie },
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe(1003);
    });

    it("rejects another user's workspace file content access", async () => {
      const res = await app.request(
        `/api/workspaces/${workspaceId}/files/content?path=notes/research.md`,
        { headers: { cookie: otherCookie } },
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe(1003);
    });

    it("keeps soft-deleted files out of list and content routes", async () => {
      await markWorkspaceFileDeleted({
        workspaceId,
        path: "notes/research.md",
      });

      const list = await app.request(`/api/workspaces/${workspaceId}/files`, {
        headers: { cookie },
      });
      expect(list.status).toBe(200);
      expect(
        (await list.json()).data.files.map((file: { path: string }) => file.path),
      ).not.toContain("notes/research.md");

      const content = await app.request(
        `/api/workspaces/${workspaceId}/files/content?path=notes/research.md`,
        { headers: { cookie } },
      );
      expect(content.status).toBe(404);
    });
  },
);

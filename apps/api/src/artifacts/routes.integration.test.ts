import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cap/db";
import { createApp } from "../app";
import { issueRunToken } from "../run/run-token";

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
      name: "Artifact Test User",
    }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("sign-up did not set a session cookie");
  return cookie;
}

describe.skipIf(!HAS_DB || !HAS_SECRET)(
  "Artifact routes（真实 Neon，见 Step 11.1）",
  () => {
    const app = createApp();
    const userEmail = `it-artifacts-${Date.now()}@example.com`;
    const otherUserEmail = `it-artifacts-other-${Date.now()}@example.com`;
    let cookie = "";
    let otherCookie = "";
    let workspaceId = "";
    let threadId = "";
    let createdArtifactId = "";

    afterAll(async () => {
      const workspaces = await prisma.workspace.findMany({
        where: { title: { startsWith: "IT-ArtifactsWs-" } },
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
        await prisma.source.deleteMany({
          where: { workspaceId: { in: workspaceIds } },
        });
        await prisma.workspaceArtifactVersion.deleteMany({
          where: { workspaceId: { in: workspaceIds } },
        });
        await prisma.workspaceArtifact.deleteMany({
          where: { workspaceId: { in: workspaceIds } },
        });
        await prisma.workspaceFile.deleteMany({
          where: { workspaceId: { in: workspaceIds } },
        });
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

    async function ingestArtifact(
      run: Awaited<ReturnType<typeof createRun>>,
      body: Record<string, unknown>,
    ) {
      return app.request("/api/ingest/artifacts", {
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
        body: JSON.stringify({ title: "IT-ArtifactsWs-Main" }),
      });
      workspaceId = (await wsRes.json()).data.workspace.id;

      const threadRes = await app.request(
        `/api/workspaces/${workspaceId}/threads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ title: "IT-ArtifactsThread" }),
        },
      );
      threadId = (await threadRes.json()).data.thread.id;

      expect(workspaceId).toBeTruthy();
      expect(threadId).toBeTruthy();
      expect(otherCookie).toBeTruthy();
    });

    it("ingests artifact first create and writes artifact_created event", async () => {
      const run = await createRun("artifact first create");
      const res = await ingestArtifact(run, {
        title: "Research Report",
        kind: "text",
        contentSnapshot: "# Research Report\n\nBody",
        eventSeq: 1,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      createdArtifactId = body.data.artifact.id;
      expect(body.data.artifact.version).toBe(1);
      expect(body.data.artifact.contentSnapshot).toBe(
        "# Research Report\n\nBody",
      );

      const event = await prisma.runEvent.findUnique({
        where: { runId_seq: { runId: run.id, seq: 1 } },
      });
      expect(event?.type).toBe("artifact_created");
      expect(event?.raw).toMatchObject({
        artifactId: createdArtifactId,
        title: "Research Report",
        kind: "text",
        version: 1,
      });
    });

    it("lists artifacts in workspace", async () => {
      const res = await app.request(
        `/api/workspaces/${workspaceId}/artifacts`,
        { headers: { cookie } },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(
        body.data.artifacts.map((artifact: { id: string }) => artifact.id),
      ).toContain(createdArtifactId);
    });

    it("gets artifact detail with sources array", async () => {
      const res = await app.request(`/api/artifacts/${createdArtifactId}`, {
        headers: { cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.artifact.id).toBe(createdArtifactId);
      expect(body.data.artifact.title).toBe("Research Report");
      expect(body.data.sources).toEqual([]);
    });

    it("gets artifact versions with one row for a single-version artifact", async () => {
      const res = await app.request(
        `/api/artifacts/${createdArtifactId}/versions`,
        { headers: { cookie } },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.versions).toHaveLength(1);
      expect(body.data.versions[0].version).toBe(1);
      expect(body.data.versions[0].contentSnapshot).toBe(
        "# Research Report\n\nBody",
      );
    });

    it("ingests artifact update and writes artifact_updated event with incremented version", async () => {
      const run = await createRun("artifact update");
      const res = await ingestArtifact(run, {
        artifactId: createdArtifactId,
        title: "Research Report v2",
        kind: "text",
        contentSnapshot: "# Research Report\n\nUpdated",
        eventSeq: 1,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.artifact.id).toBe(createdArtifactId);
      expect(body.data.artifact.version).toBe(2);
      expect(body.data.artifact.contentSnapshot).toBe(
        "# Research Report\n\nUpdated",
      );

      const event = await prisma.runEvent.findUnique({
        where: { runId_seq: { runId: run.id, seq: 1 } },
      });
      expect(event?.type).toBe("artifact_updated");
      expect(event?.raw).toMatchObject({
        artifactId: createdArtifactId,
        title: "Research Report v2",
        kind: "text",
        version: 2,
        previousVersion: 1,
      });
    });

    it("gets all artifact versions after update", async () => {
      const res = await app.request(
        `/api/artifacts/${createdArtifactId}/versions`,
        { headers: { cookie } },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.versions.map((v: { version: number }) => v.version)).toEqual([
        1,
        2,
      ]);
      expect(body.data.versions[0].contentSnapshot).toBe(
        "# Research Report\n\nBody",
      );
      expect(body.data.versions[1].contentSnapshot).toBe(
        "# Research Report\n\nUpdated",
      );
    });

    it("gets artifact download with exactly one content field", async () => {
      const res = await app.request(
        `/api/artifacts/${createdArtifactId}/download`,
        { headers: { cookie } },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.filename).toBe("research-report-v2.md");
      expect(body.data.mimeType).toBe("text/plain");
      expect(body.data.content).toBe("# Research Report\n\nUpdated");
      expect(body.data.downloadUrl).toBeUndefined();
    });

    it("rejects artifact without recoverable content", async () => {
      const run = await createRun("artifact without content");
      const res = await ingestArtifact(run, {
        title: "Missing Content",
        kind: "text",
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe(1006);
    });

    it("extracts content snapshot from a valid workspace file path", async () => {
      const run = await createRun("artifact from file path");
      await prisma.workspaceFile.create({
        data: {
          id: "it-artifact-file-1",
          workspaceId,
          path: "notes/from-file.md",
          kind: "text",
          mimeType: "text/markdown",
          size: 17,
          contentHash: "sha256:" + "b".repeat(64),
          content: "file backed report",
          latestRunId: run.id,
        },
      });

      const res = await ingestArtifact(run, {
        title: "From File",
        kind: "text",
        path: "notes/from-file.md",
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.artifact.path).toBe("notes/from-file.md");
      expect(body.data.artifact.contentSnapshot).toBe("file backed report");

      await prisma.workspaceFile.update({
        where: {
          workspaceId_path: {
            workspaceId,
            path: "notes/from-file.md",
          },
        },
        data: {
          size: 20,
          contentHash: "sha256:" + "c".repeat(64),
          content: "changed file content",
        },
      });

      const detail = await app.request(
        `/api/artifacts/${body.data.artifact.id}`,
        { headers: { cookie } },
      );
      expect(detail.status).toBe(200);
      const detailBody = await detail.json();
      expect(detailBody.data.artifact.contentSnapshot).toBe(
        "file backed report",
      );
    });

    it("user A cannot read user B's artifact", async () => {
      const res = await app.request(`/api/artifacts/${createdArtifactId}`, {
        headers: { cookie: otherCookie },
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe(1003);
    });
  },
);

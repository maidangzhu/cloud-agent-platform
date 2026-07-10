import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cap/db";
import { createApp } from "../app.js";
import { issueRunToken } from "../run/run-token.js";

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
      name: "Source Test User",
    }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("sign-up did not set a session cookie");
  return cookie;
}

describe.skipIf(!HAS_DB || !HAS_SECRET)(
  "Source routes（真实 Neon，见 Step 12.1）",
  () => {
    const app = createApp();
    const userEmail = `it-sources-${Date.now()}@example.com`;
    const otherUserEmail = `it-sources-other-${Date.now()}@example.com`;
    let cookie = "";
    let otherCookie = "";
    let workspaceId = "";
    let threadId = "";
    let runId = "";
    let artifactId = "";
    let sourceId = "";

    afterAll(async () => {
      const workspaces = await prisma.workspace.findMany({
        where: { title: { startsWith: "IT-SourcesWs-" } },
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

    it("准备：注册用户，建 workspace + thread + run + artifact", async () => {
      cookie = await signUpAndGetCookie(app, userEmail);
      otherCookie = await signUpAndGetCookie(app, otherUserEmail);

      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ title: "IT-SourcesWs-Main" }),
      });
      workspaceId = (await wsRes.json()).data.workspace.id;

      const threadRes = await app.request(
        `/api/workspaces/${workspaceId}/threads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ title: "IT-SourcesThread" }),
        },
      );
      threadId = (await threadRes.json()).data.thread.id;

      const runRes = await app.request(`/api/threads/${threadId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ prompt: "source setup" }),
      });
      runId = (await runRes.json()).data.run.id;
      const run = await prisma.agentRun.update({
        where: { id: runId },
        data: { status: "running" },
      });

      const artifactRes = await app.request("/api/ingest/artifacts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${tokenFor(run)}`,
        },
        body: JSON.stringify({
          title: "Source Backed Report",
          kind: "text",
          contentSnapshot: "report",
        }),
      });
      artifactId = (await artifactRes.json()).data.artifact.id;

      expect(workspaceId).toBeTruthy();
      expect(threadId).toBeTruthy();
      expect(runId).toBeTruthy();
      expect(artifactId).toBeTruthy();
    });

    it("ingests source referencing an artifact and writes source_recorded event", async () => {
      const run = await prisma.agentRun.findUniqueOrThrow({
        where: { id: runId },
      });
      const res = await app.request("/api/ingest/sources", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${tokenFor(run)}`,
        },
        body: JSON.stringify({
          kind: "url",
          uri: "HTTPS://Example.COM/research/",
          title: "Example Research",
          artifactId,
          eventSeq: 1,
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      sourceId = body.data.source.id;
      expect(body.data.source.uri).toBe("https://example.com/research");
      expect(body.data.source.artifactId).toBe(artifactId);

      const event = await prisma.runEvent.findUnique({
        where: { runId_seq: { runId, seq: 1 } },
      });
      expect(event?.type).toBe("source_recorded");
      expect(event?.raw).toMatchObject({
        sourceId,
        kind: "url",
        uri: "https://example.com/research",
        title: "Example Research",
      });
    });

    it("lists workspace sources", async () => {
      const res = await app.request(`/api/workspaces/${workspaceId}/sources`, {
        headers: { cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.sources.map((s: { id: string }) => s.id)).toContain(
        sourceId,
      );
    });

    it("lists run sources", async () => {
      const res = await app.request(`/api/runs/${runId}/sources`, {
        headers: { cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.sources.map((s: { id: string }) => s.id)).toContain(
        sourceId,
      );
    });

    it("rejects another user's source list access", async () => {
      const workspaceRes = await app.request(
        `/api/workspaces/${workspaceId}/sources`,
        { headers: { cookie: otherCookie } },
      );
      expect(workspaceRes.status).toBe(403);
      expect((await workspaceRes.json()).code).toBe(1003);

      const runRes = await app.request(`/api/runs/${runId}/sources`, {
        headers: { cookie: otherCookie },
      });
      expect(runRes.status).toBe(403);
      expect((await runRes.json()).code).toBe(1003);
    });

    it("artifact detail includes referencing sources", async () => {
      const res = await app.request(`/api/artifacts/${artifactId}`, {
        headers: { cookie },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.sources.map((s: { id: string }) => s.id)).toContain(
        sourceId,
      );
    });
  },
);

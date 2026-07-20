import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cap/db";
import { createApp } from "../app.js";
import { issueRunToken } from "../run/run-token.js";
import {
  addRunStreamChunk,
  createRunStreamReader,
  deleteRunStream,
  disconnectRedis,
  readRunStream,
} from "./streams.js";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const HAS_SECRET = Boolean(process.env.BETTER_AUTH_SECRET);
const HAS_REDIS = Boolean(process.env.REDIS_URL);

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
      name: "Redis Stream Test User",
    }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("sign-up did not set a session cookie");
  return cookie;
}

describe.skipIf(!HAS_DB || !HAS_SECRET || !HAS_REDIS)(
  "stream-chunk ingest（真实 Neon + Redis Streams，见 Step 13.1）",
  () => {
    const app = createApp();
    const userEmail = `it-stream-${Date.now()}@example.com`;
    let cookie = "";
    let workspaceId = "";
    let threadId = "";
    const runIds: string[] = [];

    afterAll(async () => {
      for (const runId of runIds) {
        await deleteRunStream(runId).catch(() => undefined);
      }

      const workspaces = await prisma.workspace.findMany({
        where: { title: { startsWith: "IT-StreamWs-" } },
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
        const cleanupRunIds = runs.map((r) => r.id);
        if (cleanupRunIds.length > 0) {
          await prisma.runToolCall.deleteMany({
            where: { runId: { in: cleanupRunIds } },
          });
          await prisma.runEvent.deleteMany({
            where: { runId: { in: cleanupRunIds } },
          });
          await prisma.agentRun.deleteMany({
            where: { id: { in: cleanupRunIds } },
          });
        }
        await prisma.thread.deleteMany({ where: { id: { in: threadIds } } });
        await prisma.workspace.deleteMany({
          where: { id: { in: workspaceIds } },
        });
      }
      await prisma.user.deleteMany({ where: { email: userEmail } });
      await disconnectRedis();
      await prisma.$disconnect();
    });

    async function createRun(prompt: string, status: "running" | "completed") {
      const res = await app.request(`/api/threads/${threadId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ prompt }),
      });
      expect(res.status).toBe(200);
      const runId = (await res.json()).data.run.id as string;
      runIds.push(runId);
      return prisma.agentRun.update({
        where: { id: runId },
        data: { status },
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

    async function postStreamChunk(
      run: Awaited<ReturnType<typeof createRun>>,
      body: Record<string, unknown>,
    ) {
      return app.request("/api/ingest/stream-chunk", {
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

      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ title: "IT-StreamWs-Main" }),
      });
      workspaceId = (await wsRes.json()).data.workspace.id;

      const threadRes = await app.request(
        `/api/workspaces/${workspaceId}/threads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ title: "IT-StreamThread" }),
        },
      );
      threadId = (await threadRes.json()).data.thread.id;

      expect(workspaceId).toBeTruthy();
      expect(threadId).toBeTruthy();
    });

    it("accepts chunk for active run, does not create RunEvent, and XREAD can immediately read it", async () => {
      const run = await createRun("active stream chunk", "running");
      const beforeEvents = await prisma.runEvent.count({
        where: { runId: run.id },
      });

      const res = await postStreamChunk(run, {
        chunk: "hello",
        streamType: "thinking",
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.streamEntryId).toMatch(/^\d+-\d+$/);

      const afterEvents = await prisma.runEvent.count({
        where: { runId: run.id },
      });
      expect(afterEvents).toBe(beforeEvents);

      const entries = await readRunStream({
        runId: run.id,
        cursor: "0",
        blockMs: 100,
      });
      expect(entries).toEqual([
        {
          id: body.data.streamEntryId,
          chunk: "hello",
          streamType: "thinking",
        },
      ]);
    });

    it("rejects chunk for terminal run", async () => {
      const run = await createRun("terminal stream chunk", "completed");

      const res = await postStreamChunk(run, {
        chunk: "too late",
        streamType: "content",
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe(2003);

      const entries = await readRunStream({
        runId: run.id,
        cursor: "0",
        blockMs: 100,
      });
      expect(entries).toEqual([]);
    });

    it("publishes immediately while an isolated stream reader is blocked", async () => {
      const run = await createRun("isolated blocking reader", "running");
      const reader = createRunStreamReader(5_000);
      try {
        const pendingRead = readRunStream({
          runId: run.id,
          cursor: "0",
          blockMs: 5_000,
          reader,
        });
        await new Promise((resolve) => setTimeout(resolve, 100));

        const writeStartedAt = Date.now();
        const entryId = await addRunStreamChunk({
          runId: run.id,
          chunk: "not blocked",
          streamType: "content",
        });
        const writeDurationMs = Date.now() - writeStartedAt;

        expect(writeDurationMs).toBeLessThan(1_000);
        await expect(pendingRead).resolves.toEqual([
          expect.objectContaining({ id: entryId, chunk: "not blocked" }),
        ]);
      } finally {
        reader.disconnect();
      }
    });

    it("retains more than 1000 fine-grained deltas for full replay", async () => {
      const run = await createRun("long fine-grained stream", "running");
      const chunks = Array.from({ length: 1500 }, (_, index) => `chunk-${index}`);

      await Promise.all(chunks.map((chunk) => addRunStreamChunk({
        runId: run.id,
        chunk,
        streamType: "content",
      })));

      const entries = [];
      let cursor = "0";
      while (true) {
        const page = await readRunStream({
          runId: run.id,
          cursor,
          blockMs: 100,
          count: 500,
        });
        entries.push(...page);
        if (page.length < 500) break;
        cursor = page.at(-1)?.id ?? cursor;
      }

      expect(entries).toHaveLength(chunks.length);
      expect(entries.map((entry) => entry.chunk)).toEqual(
        expect.arrayContaining(["chunk-0", "chunk-1499"]),
      );
    });
  },
);

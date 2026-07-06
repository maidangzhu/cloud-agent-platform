import { randomUUID } from "node:crypto";
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
      name: "Usage Test User",
    }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("sign-up did not set a session cookie");
  return cookie;
}

describe.skipIf(!HAS_DB || !HAS_SECRET)(
  "Usage records route（真实 Neon + 真实 Better Auth，ADR-0015）",
  () => {
    const app = createApp();
    const suiteId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const userAEmail = `it-usage-a-${suiteId}@example.com`;
    const userBEmail = `it-usage-b-${suiteId}@example.com`;
    let cookieA = "";
    let cookieB = "";
    let workspaceAId = "";
    let workspaceBId = "";
    let threadAId = "";
    let threadBId = "";
    let runA1Id = "";
    let runA2Id = "";
    let runBId = "";

    afterAll(async () => {
      const workspaces = await prisma.workspace.findMany({
        where: { title: { startsWith: "IT-UsageWs-" } },
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
          await prisma.lLMUsageRecord.deleteMany({
            where: { runId: { in: runIds } },
          });
          await prisma.source.deleteMany({ where: { runId: { in: runIds } } });
          await prisma.runEvent.deleteMany({
            where: { runId: { in: runIds } },
          });
          await prisma.runToolCall.deleteMany({
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
        where: { email: { in: [userAEmail, userBEmail] } },
      });
      await prisma.$disconnect();
    });

    async function createWorkspace(cookie: string, title: string) {
      const res = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ title }),
      });
      expect(res.status).toBe(200);
      return (await res.json()).data.workspace.id as string;
    }

    async function createThread(cookie: string, workspaceId: string, title: string) {
      const res = await app.request(`/api/workspaces/${workspaceId}/threads`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ title }),
      });
      expect(res.status).toBe(200);
      return (await res.json()).data.thread.id as string;
    }

    async function createRun(cookie: string, threadId: string, prompt: string) {
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

    async function seedUsage(params: {
      runId: string;
      provider: string;
      model: string;
      totalTokens: number;
      createdAt: Date;
    }) {
      return prisma.lLMUsageRecord.create({
        data: {
          id: randomUUID(),
          runId: params.runId,
          provider: params.provider,
          model: params.model,
          promptTokens: Math.floor(params.totalTokens / 2),
          completionTokens: params.totalTokens - Math.floor(params.totalTokens / 2),
          totalTokens: params.totalTokens,
          durationMs: params.totalTokens,
          createdAt: params.createdAt,
        },
      });
    }

    it("准备：注册用户 A/B，建 workspace/thread/run 和 usage records", async () => {
      cookieA = await signUpAndGetCookie(app, userAEmail);
      cookieB = await signUpAndGetCookie(app, userBEmail);

      workspaceAId = await createWorkspace(cookieA, `IT-UsageWs-A-${suiteId}`);
      workspaceBId = await createWorkspace(cookieB, `IT-UsageWs-B-${suiteId}`);
      threadAId = await createThread(cookieA, workspaceAId, "IT-UsageThread-A");
      threadBId = await createThread(cookieB, workspaceBId, "IT-UsageThread-B");

      const runA1 = await createRun(cookieA, threadAId, "usage route A1");
      const runA2 = await createRun(cookieA, threadAId, "usage route A2");
      const runB = await createRun(cookieB, threadBId, "usage route B");
      runA1Id = runA1.id;
      runA2Id = runA2.id;
      runBId = runB.id;

      await seedUsage({
        runId: runA1Id,
        provider: "fake",
        model: "fake-alpha",
        totalTokens: 10,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      await seedUsage({
        runId: runA1Id,
        provider: "fake",
        model: "fake-beta",
        totalTokens: 20,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      });
      await seedUsage({
        runId: runA2Id,
        provider: "search-fake",
        model: "fake-search",
        totalTokens: 30,
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
      });
      await seedUsage({
        runId: runBId,
        provider: "fake",
        model: "fake-alpha",
        totalTokens: 40,
        createdAt: new Date("2026-01-04T00:00:00.000Z"),
      });

      expect(runA1Id).toBeTruthy();
      expect(runA2Id).toBeTruthy();
      expect(runBId).toBeTruthy();
    });

    it("list own usage records only", async () => {
      const res = await app.request("/api/usage/records", {
        headers: { cookie: cookieA },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.records.map((record: { runId: string }) => record.runId)).toEqual([
        runA2Id,
        runA1Id,
        runA1Id,
      ]);
      expect(
        body.data.records.some((record: { runId: string }) => record.runId === runBId),
      ).toBe(false);
    });

    it("filter by runId", async () => {
      const res = await app.request(`/api/usage/records?runId=${runA1Id}`, {
        headers: { cookie: cookieA },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.records).toHaveLength(2);
      expect(
        body.data.records.every((record: { runId: string }) => record.runId === runA1Id),
      ).toBe(true);
    });

    it("filter by provider/model", async () => {
      const res = await app.request(
        "/api/usage/records?provider=fake&model=fake-beta",
        { headers: { cookie: cookieA } },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.records).toHaveLength(1);
      expect(body.data.records[0]).toMatchObject({
        runId: runA1Id,
        provider: "fake",
        model: "fake-beta",
        totalTokens: 20,
      });
    });

    it("pagination works with default and custom page size", async () => {
      const defaultRes = await app.request("/api/usage/records", {
        headers: { cookie: cookieA },
      });
      expect(defaultRes.status).toBe(200);
      expect((await defaultRes.json()).data.pagination).toMatchObject({
        limit: 50,
        offset: 0,
      });

      const page1 = await app.request("/api/usage/records?limit=2", {
        headers: { cookie: cookieA },
      });
      expect(page1.status).toBe(200);
      const page1Body = await page1.json();
      expect(page1Body.data.records).toHaveLength(2);
      expect(page1Body.data.pagination).toMatchObject({
        limit: 2,
        offset: 0,
        nextOffset: 2,
      });

      const page2 = await app.request("/api/usage/records?limit=2&offset=2", {
        headers: { cookie: cookieA },
      });
      expect(page2.status).toBe(200);
      const page2Body = await page2.json();
      expect(page2Body.data.records).toHaveLength(1);
      expect(page2Body.data.pagination).toMatchObject({
        limit: 2,
        offset: 2,
      });
    });

    it("run with LLM proxy calls produces LLMUsageRecord entries", async () => {
      const run = await createRun(cookieA, threadAId, "usage llm proxy");
      const res = await app.request("/api/llm-proxy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${tokenFor(run)}`,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "count llm usage" }],
          modelHint: "research-default",
        }),
      });

      expect(res.status).toBe(200);
      const list = await app.request(`/api/usage/records?runId=${run.id}`, {
        headers: { cookie: cookieA },
      });
      expect(list.status).toBe(200);
      const body = await list.json();
      expect(body.data.records[0]).toMatchObject({
        runId: run.id,
        provider: "fake",
        model: "fake-research-default",
      });
    });

    it("run with search proxy calls produces LLMUsageRecord entries", async () => {
      const run = await createRun(cookieA, threadAId, "usage search proxy");
      const res = await app.request("/api/search-proxy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${tokenFor(run)}`,
        },
        body: JSON.stringify({ query: "redis streams", limit: 2 }),
      });

      expect(res.status).toBe(200);
      const list = await app.request(
        `/api/usage/records?runId=${run.id}&provider=search-fake`,
        { headers: { cookie: cookieA } },
      );
      expect(list.status).toBe(200);
      const body = await list.json();
      expect(body.data.records[0]).toMatchObject({
        runId: run.id,
        provider: "search-fake",
        model: "fake-web-search",
      });
    });

    it("no run is ever rejected due to usage or balance", async () => {
      await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          seedUsage({
            runId: runA2Id,
            provider: "fake",
            model: `heavy-${index}`,
            totalTokens: 1_000_000 + index,
            createdAt: new Date(`2026-02-0${index + 1}T00:00:00.000Z`),
          }),
        ),
      );

      const res = await app.request(`/api/threads/${threadAId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: cookieA },
        body: JSON.stringify({ prompt: "still allowed despite usage telemetry" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.run.status).toBe("created");
    });
  },
);

import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@cap/db";
import { createApp } from "../app";
import { issueRunToken } from "../run/run-token";
import { runScriptedIngestFixture } from "../sandbox/scripted-ingest-fixture";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const HAS_SECRET = Boolean(process.env.BETTER_AUTH_SECRET);
const HAS_EXA_SEARCH = Boolean(process.env.EXA_API_KEY?.trim());

type TestServer = {
  url: string;
  close: () => Promise<void>;
};

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
      name: "Search Proxy Test User",
    }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("sign-up did not set a session cookie");
  return cookie;
}

async function startJsonServer(
  handler: (req: { url?: string }) => { status: number; body: unknown },
): Promise<TestServer> {
  const server: Server = createServer((req, res) => {
    const result = handler({ url: req.url });
    res.statusCode = result.status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/search`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe.skipIf(!HAS_DB || !HAS_SECRET)(
  "Search proxy（真实 Neon + scoped run token，见 Step 15.1）",
  () => {
    const app = createApp();
    const userEmail = `it-search-${Date.now()}@example.com`;
    let cookie = "";
    let workspaceId = "";
    let threadId = "";
    const savedEnv = {
      provider: process.env.SEARCH_PROXY_PROVIDER,
      baseUrl: process.env.SEARCH_PROXY_BASE_URL,
      backoffMs: process.env.SEARCH_PROXY_BACKOFF_MS,
    };

    afterEach(() => {
      if (savedEnv.provider === undefined) delete process.env.SEARCH_PROXY_PROVIDER;
      else process.env.SEARCH_PROXY_PROVIDER = savedEnv.provider;
      if (savedEnv.baseUrl === undefined) delete process.env.SEARCH_PROXY_BASE_URL;
      else process.env.SEARCH_PROXY_BASE_URL = savedEnv.baseUrl;
      if (savedEnv.backoffMs === undefined) delete process.env.SEARCH_PROXY_BACKOFF_MS;
      else process.env.SEARCH_PROXY_BACKOFF_MS = savedEnv.backoffMs;
    });

    afterAll(async () => {
      const workspaces = await prisma.workspace.findMany({
        where: { title: { startsWith: "IT-SearchWs-" } },
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
      await prisma.user.deleteMany({ where: { email: userEmail } });
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
      return prisma.agentRun.update({
        where: { id: runId },
        data: {
          status,
          ...(status === "completed" ? { completedAt: new Date() } : {}),
        },
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

    it("准备：注册用户，建 workspace + thread", async () => {
      cookie = await signUpAndGetCookie(app, userEmail);

      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ title: "IT-SearchWs-Main" }),
      });
      workspaceId = (await wsRes.json()).data.workspace.id;

      const threadRes = await app.request(
        `/api/workspaces/${workspaceId}/threads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ title: "IT-SearchThread" }),
        },
      );
      threadId = (await threadRes.json()).data.thread.id;

      expect(workspaceId).toBeTruthy();
      expect(threadId).toBeTruthy();
    });

    it("reject missing token -> 401", async () => {
      const res = await app.request("/api/search-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "redis streams" }),
      });

      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe(1002);
    });

    it("reject terminal run -> RUN_TERMINAL", async () => {
      const run = await createRun("search terminal reject", "completed");

      const res = await app.request("/api/search-proxy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${tokenFor(run)}`,
        },
        body: JSON.stringify({ query: "too late" }),
      });

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe(2003);
    });

    it("fake provider returns normalized results and records usage/source records", async () => {
      const run = await createRun("search fake success", "running");

      const res = await app.request("/api/search-proxy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${tokenFor(run)}`,
        },
        body: JSON.stringify({ query: "redis streams", limit: 2 }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.provider).toBe("search-fake");
      expect(body.data.results).toEqual([
        {
          url: "https://search.example.com/redis%20streams/1",
          title: "Fake result 1 for redis streams",
          snippet: "Deterministic fake search snippet 1 for redis streams.",
        },
        {
          url: "https://search.example.com/redis%20streams/2",
          title: "Fake result 2 for redis streams",
          snippet: "Deterministic fake search snippet 2 for redis streams.",
        },
      ]);

      const usage = await prisma.lLMUsageRecord.findFirst({
        where: { runId: run.id },
      });
      expect(usage).toMatchObject({
        provider: "search-fake",
        model: "fake-web-search",
      });

      const sources = await prisma.source.findMany({
        where: { runId: run.id, kind: "search_result" },
        orderBy: { createdAt: "asc" },
      });
      expect(sources.map((source) => source.uri).sort()).toEqual([
        "https://search.example.com/redis%20streams/1",
        "https://search.example.com/redis%20streams/2",
      ]);
    });

    it("retries on 5xx up to 2 times with backoff", async () => {
      let calls = 0;
      const server = await startJsonServer(() => {
        calls += 1;
        if (calls < 3) return { status: 503, body: { error: "temporary" } };
        return {
          status: 200,
          body: {
            results: [{ url: "https://example.com/ok", title: "OK" }],
          },
        };
      });
      process.env.SEARCH_PROXY_PROVIDER = "http";
      process.env.SEARCH_PROXY_BASE_URL = server.url;
      process.env.SEARCH_PROXY_BACKOFF_MS = "0,0";
      const run = await createRun("search retry success", "running");

      try {
        const res = await app.request("/api/search-proxy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authorization: `Bearer ${tokenFor(run)}`,
          },
          body: JSON.stringify({ query: "retry", limit: 1 }),
        });

        expect(res.status).toBe(200);
        expect(calls).toBe(3);
        const body = await res.json();
        expect(body.data.attempts.map((a: { outcome: string }) => a.outcome)).toEqual([
          "retry",
          "retry",
          "success",
        ]);
      } finally {
        await server.close();
      }
    });

    it("does not retry on 4xx -> SEARCH_PROXY_FAILED", async () => {
      let calls = 0;
      const server = await startJsonServer(() => {
        calls += 1;
        return { status: 429, body: { error: "quota" } };
      });
      process.env.SEARCH_PROXY_PROVIDER = "http";
      process.env.SEARCH_PROXY_BASE_URL = server.url;
      process.env.SEARCH_PROXY_BACKOFF_MS = "0,0";
      const run = await createRun("search no retry 4xx", "running");

      try {
        const res = await app.request("/api/search-proxy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authorization: `Bearer ${tokenFor(run)}`,
          },
          body: JSON.stringify({ query: "quota", limit: 1 }),
        });

        expect(res.status).toBe(502);
        expect(calls).toBe(1);
        expect((await res.json()).code).toBe(3001);
      } finally {
        await server.close();
      }
    });

    it("scripted ingest fixture calls fake search proxy via web_search tool", async () => {
      const run = await createRun("scripted ingest fixture web search", "running");

      const result = await runScriptedIngestFixture({
        mode: "web-search",
        searchQuery: "agent runtime",
        runToken: tokenFor(run),
        env: { PATH: "/usr/bin" },
        request: (path, init) => Promise.resolve(app.request(path, init)),
        stepDelayMs: 1,
      });

      expect(result.calls.map((call) => call.path)).toContain(
        "/api/search-proxy",
      );
      const sources = await prisma.source.findMany({
        where: { runId: run.id, kind: "search_result" },
      });
      expect(sources).toHaveLength(2);
      expect(sources[0]?.uri).toContain("https://search.example.com/");
    });

    it.skipIf(!HAS_EXA_SEARCH)("real Exa provider returns normalized results", async () => {
      const run = await createRun("exa search smoke", "running");

      const res = await app.request("/api/search-proxy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${tokenFor(run)}`,
        },
        body: JSON.stringify({
          provider: "exa",
          query: "Redis Streams official docs",
          limit: 3,
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.provider).toBe("search-exa");
      expect(body.data.model).toBe("exa-search");
      expect(body.data.results.length).toBeGreaterThan(0);
      expect(body.data.results[0].url).toMatch(/^https?:\/\//);
      expect(body.data.results[0].title).toBeTruthy();

      const usage = await prisma.lLMUsageRecord.findFirst({
        where: { runId: run.id, provider: "search-exa" },
      });
      expect(usage?.model).toBe("exa-search");

      const sources = await prisma.source.findMany({
        where: { runId: run.id, kind: "search_result" },
      });
      expect(sources.length).toBeGreaterThan(0);
    }, 60_000);
  },
);

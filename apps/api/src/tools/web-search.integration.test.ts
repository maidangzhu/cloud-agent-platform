import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cap/db";
import { createApp } from "../app";
import { issueRunToken } from "../run/run-token";
import { runFakeRunner } from "../sandbox/fake-runner";
import { webSearchTool, type WebSearchResult } from "./web-search";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const HAS_SECRET = Boolean(process.env.BETTER_AUTH_SECRET);

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
      name: "Web Search Tool Test User",
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
  "web_search tool integration（真实 Neon + search proxy，见 Step 15.4）",
  () => {
    const app = createApp();
    const userEmail = `it-web-search-${Date.now()}@example.com`;
    let cookie = "";
    let workspaceId = "";
    let threadId = "";
    const savedEnv = {
      provider: process.env.SEARCH_PROXY_PROVIDER,
      baseUrl: process.env.SEARCH_PROXY_BASE_URL,
      backoffMs: process.env.SEARCH_PROXY_BACKOFF_MS,
    };

    afterAll(async () => {
      if (savedEnv.provider === undefined) delete process.env.SEARCH_PROXY_PROVIDER;
      else process.env.SEARCH_PROXY_PROVIDER = savedEnv.provider;
      if (savedEnv.baseUrl === undefined) delete process.env.SEARCH_PROXY_BASE_URL;
      else process.env.SEARCH_PROXY_BASE_URL = savedEnv.baseUrl;
      if (savedEnv.backoffMs === undefined) delete process.env.SEARCH_PROXY_BACKOFF_MS;
      else process.env.SEARCH_PROXY_BACKOFF_MS = savedEnv.backoffMs;

      const workspaces = await prisma.workspace.findMany({
        where: { title: { startsWith: "IT-WebSearchWs-" } },
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
      await prisma.user.deleteMany({ where: { email: userEmail } });
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

    async function ingestToolResult(params: {
      run: Awaited<ReturnType<typeof createRun>>;
      toolCallId: string;
      query: string;
      result: WebSearchResult;
    }) {
      const token = tokenFor(params.run);
      const base = {
        id: params.toolCallId,
        eventSeq: 1,
        name: "web_search",
        args: { query: params.query, limit: 1 },
      };
      const running = await app.request("/api/ingest/tool-calls", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ...base, status: "running" }),
      });
      expect(running.status).toBe(200);

      const terminal = await app.request("/api/ingest/tool-calls", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ...base,
          status: params.result.status,
          ...(params.result.status === "completed"
            ? { result: params.result.result }
            : { error: params.result.error }),
        }),
      });
      expect(terminal.status).toBe(200);
    }

    it("准备：注册用户，建 workspace + thread", async () => {
      cookie = await signUpAndGetCookie(app, userEmail);

      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ title: "IT-WebSearchWs-Main" }),
      });
      workspaceId = (await wsRes.json()).data.workspace.id;

      const threadRes = await app.request(
        `/api/workspaces/${workspaceId}/threads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ title: "IT-WebSearchThread" }),
        },
      );
      threadId = (await threadRes.json()).data.thread.id;

      expect(workspaceId).toBeTruthy();
      expect(threadId).toBeTruthy();
    });

    it("web_search succeeds -> ToolCall completed, results as Sources", async () => {
      const run = await createRun("web search completed");

      const result = await runFakeRunner({
        mode: "web-search",
        searchQuery: "agent runtime",
        runToken: tokenFor(run),
        env: { PATH: "/usr/bin" },
        request: (path, init) => Promise.resolve(app.request(path, init)),
        stepDelayMs: 1,
      });

      expect(result.completed).toBe(true);
      expect(result.calls.map((call) => call.path)).toContain("/api/search-proxy");
      const tool = await prisma.runToolCall.findFirst({
        where: { runId: run.id, name: "web_search" },
      });
      expect(tool?.status).toBe("completed");
      const sources = await prisma.source.findMany({
        where: { runId: run.id, kind: "search_result" },
      });
      expect(sources).toHaveLength(2);
    });

    it("web_search retries up to 2 times on 5xx then succeeds", async () => {
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
      const run = await createRun("web search retry complete");

      try {
        const result = await webSearchTool({
          query: "retry",
          limit: 1,
          runToken: tokenFor(run),
          request: (path, init) => Promise.resolve(app.request(path, init)),
          backoffMs: [0, 0],
          sleep: async () => undefined,
        });
        await ingestToolResult({
          run,
          toolCallId: "web_search_retry_1",
          query: "retry",
          result,
        });

        expect(calls).toBe(3);
        expect(result.status).toBe("completed");
        const tool = await prisma.runToolCall.findUniqueOrThrow({
          where: { id: "web_search_retry_1" },
        });
        expect(tool.status).toBe("completed");
      } finally {
        await server.close();
      }
    });

    it("web_search 4xx does not retry -> ToolCall failed", async () => {
      let calls = 0;
      const run = await createRun("web search 4xx failed");
      const result = await webSearchTool({
        query: "bad request",
        limit: 1,
        runToken: tokenFor(run),
        request: async () => {
          calls += 1;
          return new Response(
            JSON.stringify({ code: 1006, message: "bad query", data: null }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        },
        backoffMs: [0, 0],
        sleep: async () => undefined,
      });
      await ingestToolResult({
        run,
        toolCallId: "web_search_4xx_1",
        query: "bad request",
        result,
      });

      expect(calls).toBe(1);
      expect(result.status).toBe("failed");
      const tool = await prisma.runToolCall.findUniqueOrThrow({
        where: { id: "web_search_4xx_1" },
      });
      expect(tool.status).toBe("failed");
      expect(tool.error).toBe("bad query");
    });
  },
);

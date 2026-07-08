import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cap/db";
import { createApp } from "../app.js";
import { issueRunToken } from "../run/run-token.js";
import { fetchUrlTool, type FetchUrlResult, type FetchUrlTransport } from "./fetch-url.js";

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
      name: "Fetch URL Tool Test User",
    }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("sign-up did not set a session cookie");
  return cookie;
}

function response(body: BodyInit, status = 200, contentType = "text/html") {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

describe.skipIf(!HAS_DB || !HAS_SECRET)(
  "fetch_url tool integration（真实 Neon + ingest HTTP，见 Step 15.3）",
  () => {
    const app = createApp();
    const userEmail = `it-fetch-url-${Date.now()}@example.com`;
    let cookie = "";
    let workspaceId = "";
    let threadId = "";

    afterAll(async () => {
      const workspaces = await prisma.workspace.findMany({
        where: { title: { startsWith: "IT-FetchUrlWs-" } },
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
      url: string;
      result: FetchUrlResult;
    }) {
      const token = tokenFor(params.run);
      const base = {
        id: params.toolCallId,
        eventSeq: 1,
        name: "fetch_url",
        args: { url: params.url },
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

      const status = params.result.status;
      const terminal = await app.request("/api/ingest/tool-calls", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ...base,
          status,
          ...(status === "completed" ? { result: params.result.result } : {}),
          ...(status !== "completed" ? { error: params.result.error } : {}),
        }),
      });
      expect(terminal.status).toBe(200);

      if (params.result.status === "completed") {
        const source = await app.request("/api/ingest/sources", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            kind: "url",
            uri: params.result.result.url,
            title: params.result.result.title,
            contentHash: params.result.result.contentHash,
            metadata: {
              statusCode: params.result.result.statusCode,
              contentType: params.result.result.contentType,
              truncated: params.result.result.truncated,
              size: params.result.result.size,
            },
          }),
        });
        expect(source.status).toBe(200);
      }
    }

    it("准备：注册用户，建 workspace + thread", async () => {
      cookie = await signUpAndGetCookie(app, userEmail);

      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ title: "IT-FetchUrlWs-Main" }),
      });
      workspaceId = (await wsRes.json()).data.workspace.id;

      const threadRes = await app.request(
        `/api/workspaces/${workspaceId}/threads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ title: "IT-FetchUrlThread" }),
        },
      );
      threadId = (await threadRes.json()).data.thread.id;

      expect(workspaceId).toBeTruthy();
      expect(threadId).toBeTruthy();
    });

    it("fetch_url succeeds on first try -> ToolCall completed and Source(kind=url) recorded", async () => {
      const run = await createRun("fetch url complete");
      const result = await fetchUrlTool({
        url: "https://example.com/article",
        transport: async () =>
          response("<title>Example Article</title>Body", 200, "text/html"),
      });

      await ingestToolResult({
        run,
        toolCallId: "fetch_completed_1",
        url: "https://example.com/article",
        result,
      });

      const tool = await prisma.runToolCall.findUniqueOrThrow({
        where: { id: "fetch_completed_1" },
      });
      expect(tool.status).toBe("completed");
      const source = await prisma.source.findFirst({
        where: { runId: run.id, kind: "url" },
      });
      expect(source?.uri).toBe("https://example.com/article");
      expect(source?.title).toBe("Example Article");
    });

    it("fetch_url retries once on network failure then succeeds -> completed", async () => {
      const run = await createRun("fetch url retry complete");
      let calls = 0;
      const transport: FetchUrlTransport = async () => {
        calls += 1;
        if (calls === 1) throw new Error("ECONNRESET");
        return response("ok", 200, "text/plain");
      };

      const result = await fetchUrlTool({
        url: "https://example.com/retry",
        transport,
        backoffMs: [0],
        sleep: async () => undefined,
      });
      await ingestToolResult({
        run,
        toolCallId: "fetch_retry_1",
        url: "https://example.com/retry",
        result,
      });

      expect(calls).toBe(2);
      const tool = await prisma.runToolCall.findUniqueOrThrow({
        where: { id: "fetch_retry_1" },
      });
      expect(tool.status).toBe("completed");
    });

    it("fetch_url exhausts retry then fails -> ToolCall failed", async () => {
      const run = await createRun("fetch url failed");
      const result = await fetchUrlTool({
        url: "https://example.com/down",
        transport: async () => {
          throw new Error("DNS failure");
        },
        backoffMs: [0],
        sleep: async () => undefined,
      });
      await ingestToolResult({
        run,
        toolCallId: "fetch_failed_1",
        url: "https://example.com/down",
        result,
      });

      const tool = await prisma.runToolCall.findUniqueOrThrow({
        where: { id: "fetch_failed_1" },
      });
      expect(tool.status).toBe("failed");
      expect(tool.error).toBe("DNS failure");
    });

    it("fetch_url SSRF guard triggers -> ToolCall rejected, not failed", async () => {
      const run = await createRun("fetch url rejected");
      const result = await fetchUrlTool({
        url: "http://169.254.169.254/latest/meta-data",
        transport: async () => response("metadata"),
      });
      await ingestToolResult({
        run,
        toolCallId: "fetch_rejected_1",
        url: "http://169.254.169.254/latest/meta-data",
        result,
      });

      const tool = await prisma.runToolCall.findUniqueOrThrow({
        where: { id: "fetch_rejected_1" },
      });
      expect(tool.status).toBe("rejected");
      expect(tool.error).toMatch(/SSRF/);
    });
  },
);

import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cap/db";
import { createApp } from "../app";
import { issueRunToken } from "../run/run-token";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const HAS_SECRET = Boolean(process.env.BETTER_AUTH_SECRET);
const HAS_REAL_LLM =
  Boolean(process.env.OPENAI_API_KEY?.trim()) &&
  Boolean(process.env.OPENAI_BASE_URL?.trim()) &&
  Boolean(process.env.LLM_MODEL?.trim());

type SseRecord = {
  event?: string;
  data: string;
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
      name: "LLM Proxy Test User",
    }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("sign-up did not set a session cookie");
  return cookie;
}

function parseSseRecords(text: string): SseRecord[] {
  return text
    .trim()
    .split(/\n\n+/)
    .filter(Boolean)
    .map((chunk) => {
      const record: SseRecord = { data: "" };
      for (const line of chunk.split(/\n/)) {
        if (line.startsWith("event: ")) record.event = line.slice(7);
        if (line.startsWith("data: ")) {
          record.data = record.data
            ? `${record.data}\n${line.slice(6)}`
            : line.slice(6);
        }
      }
      return record;
    });
}

describe.skipIf(!HAS_DB || !HAS_SECRET)(
  "LLM proxy fake provider（真实 Neon + scoped run token，见 Step 14.1）",
  () => {
    const app = createApp();
    const userEmail = `it-llm-${Date.now()}@example.com`;
    let cookie = "";
    let workspaceId = "";
    let threadId = "";

    afterAll(async () => {
      const workspaces = await prisma.workspace.findMany({
        where: { title: { startsWith: "IT-LlmWs-" } },
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
        data: { status, ...(status === "completed" ? { completedAt: new Date() } : {}) },
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
        body: JSON.stringify({ title: "IT-LlmWs-Main" }),
      });
      workspaceId = (await wsRes.json()).data.workspace.id;

      const threadRes = await app.request(
        `/api/workspaces/${workspaceId}/threads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ title: "IT-LlmThread" }),
        },
      );
      threadId = (await threadRes.json()).data.thread.id;

      expect(workspaceId).toBeTruthy();
      expect(threadId).toBeTruthy();
    });

    it("reject missing token -> 401", async () => {
      const res = await app.request("/api/llm-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [] }),
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe(1002);
    });

    it("reject wrong run token -> RUN_TOKEN_INVALID", async () => {
      const targetRun = await createRun("llm wrong token target", "running");
      const otherRun = await createRun("llm wrong token source", "running");

      const res = await app.request("/api/llm-proxy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${tokenFor(otherRun)}`,
        },
        body: JSON.stringify({
          runId: targetRun.id,
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe(2002);
    });

    it("reject terminal run -> RUN_TERMINAL", async () => {
      const run = await createRun("llm terminal reject", "completed");

      const res = await app.request("/api/llm-proxy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${tokenFor(run)}`,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "too late" }],
        }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe(2003);
    });

    it("fake provider success returns model output", async () => {
      const run = await createRun("llm fake success", "running");

      const res = await app.request("/api/llm-proxy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${tokenFor(run)}`,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "summarize Redis Streams" }],
          modelHint: "research-default",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.provider).toBe("fake");
      expect(body.data.model).toBe("fake-research-default");
      expect(body.data.output.reasoning).toBe(
        "fake reasoning for: summarize Redis Streams",
      );
      expect(body.data.output.content).toBe(
        "fake response for: summarize Redis Streams",
      );
      expect(body.data.finishReason).toBe("stop");
      expect(body.data.usage.totalTokens).toBeGreaterThan(0);
    });

    it("streaming response chunks are forwarded to sandbox in order", async () => {
      const run = await createRun("llm fake stream", "running");

      const res = await app.request("/api/llm-proxy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${tokenFor(run)}`,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "stream this" }],
          stream: true,
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const records = parseSseRecords(await res.text());
      expect(records.map((record) => record.event)).toEqual([
        "chunk",
        "chunk",
        "done",
      ]);
      const parsed = records.map((record) => JSON.parse(record.data));
      expect(parsed[0]).toEqual({
        provider: "fake",
        model: "fake-research-default",
        part: "reason",
        text: "fake reasoning for: stream this",
      });
      expect(parsed[1]).toEqual({
        provider: "fake",
        model: "fake-research-default",
        part: "content",
        text: "fake response for: stream this",
      });
      expect(parsed[2]).toMatchObject({
        provider: "fake",
        model: "fake-research-default",
        finishReason: "stop",
        usage: {
          inputTokens: 2,
          outputTokens: 10,
          totalTokens: 12,
        },
      });
      expect(parsed[2].durationMs).toBeGreaterThanOrEqual(0);
      expect(parsed[2].attempts).toHaveLength(1);
    });

    it.skipIf(!HAS_REAL_LLM)("real provider returns normalized response", async () => {
      const run = await createRun("llm real smoke", "running");

      const res = await app.request("/api/llm-proxy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${tokenFor(run)}`,
        },
        body: JSON.stringify({
          provider: "real",
          messages: [
            {
              role: "user",
              content: "Reply with exactly one short sentence about Redis Streams.",
            },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.provider).toBe("openai-compatible");
      expect(body.data.model).toBeTruthy();
      expect(body.data.finishReason).toMatch(/^(stop|length|tool_calls|content_filter|unknown)$/);
      expect(
        body.data.output.content ||
          body.data.output.reasoning ||
          body.data.output.toolCalls.length,
      ).toBeTruthy();
      expect(body.data.durationMs).toBeGreaterThanOrEqual(0);
      expect(body.data.attempts.length).toBeGreaterThanOrEqual(1);
    }, 120_000);
  },
);

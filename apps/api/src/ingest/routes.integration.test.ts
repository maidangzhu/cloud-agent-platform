import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cap/db";
import { createApp } from "../app";
import { issueRunToken } from "../run/run-token";

// 连真实 Neon Postgres + 真实 Better Auth，不 mock。对应
// docs/testing-strategy.md §4.5 route 10-17、docs/implementation-roadmap.md
// Step 8.1。这里首次通过真实 HTTP ingest 端点写 RunEvent/heartbeat；
// 仍不接真实 sandbox。
const HAS_DB = !!process.env.DATABASE_URL;
const HAS_SECRET = !!process.env.BETTER_AUTH_SECRET;

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
      name: "Ingest Test User",
    }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("sign-up did not set a session cookie");
  return cookie;
}

describe.skipIf(!HAS_DB || !HAS_SECRET)(
  "Ingest events/heartbeat routes（真实 Neon + scoped run token，见 Step 8.1）",
  () => {
    const app = createApp();
    const userEmail = `it-ingest-${Date.now()}@example.com`;
    let cookie = "";
    let workspaceId = "";
    let threadId = "";

    afterAll(async () => {
      const workspaces = await prisma.workspace.findMany({
        where: { title: { startsWith: "IT-IngestWs-" } },
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

    async function createRun(prompt: string) {
      const res = await app.request(`/api/threads/${threadId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ prompt }),
      });
      expect(res.status).toBe(200);
      const runId = (await res.json()).data.run.id as string;
      const run = await prisma.agentRun.findUniqueOrThrow({
        where: { id: runId },
      });
      return run;
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
        body: JSON.stringify({ title: "IT-IngestWs-Main" }),
      });
      workspaceId = (await wsRes.json()).data.workspace.id;

      const threadRes = await app.request(
        `/api/workspaces/${workspaceId}/threads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ title: "IT-IngestThread" }),
        },
      );
      threadId = (await threadRes.json()).data.thread.id;

      expect(workspaceId).toBeTruthy();
      expect(threadId).toBeTruthy();
    });

    it("ingest event with valid token", async () => {
      const run = await createRun("valid ingest check");

      const res = await app.request("/api/ingest/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${tokenFor(run)}`,
        },
        body: JSON.stringify({
          seq: 1,
          type: "agent_message",
          content: "hello",
          payload: { messageId: "msg_1" },
        }),
      });

      expect(res.status).toBe(200);
      const event = await prisma.runEvent.findUnique({
        where: { runId_seq: { runId: run.id, seq: 1 } },
      });
      expect(event?.type).toBe("agent_message");
      expect(event?.content).toBe("hello");
    });

    it("reject ingest without token -> 401", async () => {
      const res = await app.request("/api/ingest/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seq: 1,
          type: "run_created",
          payload: null,
        }),
      });

      expect(res.status).toBe(401);
    });

    it("reject token for wrong run -> RUN_TOKEN_INVALID", async () => {
      const targetRun = await createRun("wrong token target");
      const otherRun = await createRun("wrong token source");

      const res = await app.request("/api/ingest/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${tokenFor(otherRun)}`,
        },
        body: JSON.stringify({
          runId: targetRun.id,
          seq: 1,
          type: "run_created",
          payload: null,
        }),
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe(2002);
    });

    it("terminal run rejects new event -> RUN_TERMINAL", async () => {
      const run = await createRun("terminal reject check");
      await prisma.agentRun.update({
        where: { id: run.id },
        data: { status: "completed" },
      });

      const res = await app.request("/api/ingest/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${tokenFor(run)}`,
        },
        body: JSON.stringify({
          seq: 1,
          type: "agent_message",
          content: "too late",
          payload: { messageId: "msg_late" },
        }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe(2003);
    });

    it("waiting_for_input run rejects new ordinary event", async () => {
      const run = await createRun("waiting reject check");
      await prisma.agentRun.update({
        where: { id: run.id },
        data: { status: "waiting_for_input" },
      });

      const res = await app.request("/api/ingest/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${tokenFor(run)}`,
        },
        body: JSON.stringify({
          seq: 1,
          type: "agent_message",
          content: "ordinary event",
          payload: { messageId: "msg_waiting" },
        }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe(2005);
    });

    it("ingest run_waiting_for_input event -> run transitions to waiting_for_input", async () => {
      const run = await createRun("waiting transition check");
      await prisma.agentRun.update({
        where: { id: run.id },
        data: { status: "running" },
      });

      const res = await app.request("/api/ingest/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${tokenFor(run)}`,
        },
        body: JSON.stringify({
          seq: 1,
          type: "run_waiting_for_input",
          payload: { question: "Choose next step", options: ["A", "B"] },
        }),
      });

      expect(res.status).toBe(200);
      const updated = await prisma.agentRun.findUnique({
        where: { id: run.id },
      });
      expect(updated?.status).toBe("waiting_for_input");
    });

    it("ingest artifact_updated event requires existing artifactId", async () => {
      const run = await createRun("artifact updated check");
      const token = tokenFor(run);

      const missing = await app.request("/api/ingest/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          seq: 1,
          type: "artifact_updated",
          payload: {
            artifactId: "artifact_1",
            title: "Report",
            kind: "text",
            version: 2,
            previousVersion: 1,
          },
        }),
      });
      expect(missing.status).toBe(400);

      const created = await app.request("/api/ingest/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          seq: 1,
          type: "artifact_created",
          payload: {
            artifactId: "artifact_1",
            title: "Report",
            kind: "text",
            version: 1,
          },
        }),
      });
      expect(created.status).toBe(200);

      const updated = await app.request("/api/ingest/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          seq: 2,
          type: "artifact_updated",
          payload: {
            artifactId: "artifact_1",
            title: "Report",
            kind: "text",
            version: 2,
            previousVersion: 1,
          },
        }),
      });
      expect(updated.status).toBe(200);
    });

    it("ingest heartbeat with phase field persists Run.lastHeartbeatAt and phase", async () => {
      const run = await createRun("heartbeat phase check");
      await prisma.agentRun.update({
        where: { id: run.id },
        data: { status: "running" },
      });

      const res = await app.request("/api/ingest/heartbeat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${tokenFor(run)}`,
        },
        body: JSON.stringify({ status: "running", phase: "agent_loop" }),
      });

      expect(res.status).toBe(200);
      const updated = await prisma.agentRun.findUnique({
        where: { id: run.id },
      });
      expect(updated?.lastHeartbeatAt).toBeInstanceOf(Date);
      expect(updated?.phase).toBe("agent_loop");

      const eventCount = await prisma.runEvent.count({
        where: { runId: run.id },
      });
      expect(eventCount).toBe(0);
    });

    it("records tool call pending -> running -> completed", async () => {
      const run = await createRun("tool call completed check");
      const token = tokenFor(run);

      const pending = await app.request("/api/ingest/tool-calls", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: "tool_completed_1",
          eventSeq: 1,
          name: "fetch_url",
          status: "pending",
          args: { url: "https://example.com" },
        }),
      });
      expect(pending.status).toBe(200);

      const running = await app.request("/api/ingest/tool-calls", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: "tool_completed_1",
          eventSeq: 1,
          name: "fetch_url",
          status: "running",
          args: { url: "https://example.com" },
        }),
      });
      expect(running.status).toBe(200);

      const completed = await app.request("/api/ingest/tool-calls", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: "tool_completed_1",
          eventSeq: 1,
          name: "fetch_url",
          status: "completed",
          args: { url: "https://example.com" },
          result: { title: "Example" },
        }),
      });
      expect(completed.status).toBe(200);

      const row = await prisma.runToolCall.findUnique({
        where: { id: "tool_completed_1" },
      });
      expect(row?.status).toBe("completed");
      expect(row?.result).toEqual({ title: "Example" });
      expect(row?.completedAt).toBeInstanceOf(Date);
    });

    it("records running -> failed and running -> rejected distinctly", async () => {
      const run = await createRun("tool call failed rejected check");
      const token = tokenFor(run);

      for (const id of ["tool_failed_1", "tool_rejected_1"]) {
        const running = await app.request("/api/ingest/tool-calls", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            id,
            eventSeq: id === "tool_failed_1" ? 2 : 3,
            name: "fetch_url",
            status: "running",
            args: { url: "https://example.com" },
          }),
        });
        expect(running.status).toBe(200);
      }

      const failed = await app.request("/api/ingest/tool-calls", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: "tool_failed_1",
          eventSeq: 2,
          name: "fetch_url",
          status: "failed",
          args: { url: "https://example.com" },
          error: "network retries exhausted",
        }),
      });
      expect(failed.status).toBe(200);

      const rejected = await app.request("/api/ingest/tool-calls", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: "tool_rejected_1",
          eventSeq: 3,
          name: "fetch_url",
          status: "rejected",
          args: { url: "http://127.0.0.1" },
          error: "SSRF guard rejected private address",
        }),
      });
      expect(rejected.status).toBe(200);

      const rows = await prisma.runToolCall.findMany({
        where: { runId: run.id },
        orderBy: { eventSeq: "asc" },
      });
      expect(rows.map((row) => row.status)).toEqual(["failed", "rejected"]);
      expect(rows.map((row) => row.error)).toEqual([
        "network retries exhausted",
        "SSRF guard rejected private address",
      ]);
    });

    it("terminal tool call cannot later be completed", async () => {
      const run = await createRun("tool call terminal check");
      const token = tokenFor(run);

      const rejected = await app.request("/api/ingest/tool-calls", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: "tool_terminal_1",
          eventSeq: 4,
          name: "run_command",
          status: "rejected",
          args: { command: "rm -rf /" },
          error: "policy rejected dangerous command",
        }),
      });
      expect(rejected.status).toBe(200);

      const completed = await app.request("/api/ingest/tool-calls", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: "tool_terminal_1",
          eventSeq: 4,
          name: "run_command",
          status: "completed",
          args: { command: "rm -rf /" },
          result: { exitCode: 0 },
        }),
      });
      expect(completed.status).toBe(409);

      const row = await prisma.runToolCall.findUnique({
        where: { id: "tool_terminal_1" },
      });
      expect(row?.status).toBe("rejected");
      expect(row?.result).toBeNull();
    });
  },
);

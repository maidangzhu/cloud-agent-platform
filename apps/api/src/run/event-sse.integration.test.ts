import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cap/db";
import { createApp } from "../app";
import { insertRunEvent } from "./event-store";
import { issueRunToken } from "./run-token";
import { deleteRunStream, disconnectRedis } from "../redis/streams";

// 连真实 Neon Postgres + 真实 Better Auth，不 mock。对应
// docs/testing-strategy.md §4.5 SSE 22-28。业务事实事件通过
// Step 6.4 的测试 helper 直接写 RunEvent，不走真实 ingest HTTP 端点
// （Group 8 才实现）；stream chunk 走真实 HTTP ingest + Redis Streams。
const HAS_DB = !!process.env.DATABASE_URL;
const HAS_SECRET = !!process.env.BETTER_AUTH_SECRET;
const HAS_REDIS = !!process.env.REDIS_URL;

type SseRecord = {
  event?: string;
  id?: string;
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
      name: "Event SSE Test User",
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
        if (line.startsWith("id: ")) record.id = line.slice(4);
        if (line.startsWith("data: ")) {
          record.data = record.data
            ? `${record.data}\n${line.slice(6)}`
            : line.slice(6);
        }
      }
      return record;
    });
}

async function readSseUntil(
  response: Response,
  predicate: (record: SseRecord) => boolean,
): Promise<{ records: SseRecord[]; matched: SseRecord }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("response has no body");

  const decoder = new TextDecoder();
  const records: SseRecord[] = [];
  let buffer = "";
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary + 2);
      buffer = buffer.slice(boundary + 2);
      const [record] = parseSseRecords(raw);
      if (record) {
        records.push(record);
        if (predicate(record)) {
          await reader.cancel().catch(() => undefined);
          return { records, matched: record };
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }

  throw new Error(
    `SSE event did not arrive. Received: ${JSON.stringify(records)}`,
  );
}

describe.skipIf(!HAS_DB || !HAS_SECRET || !HAS_REDIS)(
  "Run events SSE（真实 Neon + Better Auth + Redis Streams，见 Step 13.2）",
  () => {
    const app = createApp();
    const userEmail = `it-sse-${Date.now()}@example.com`;
    let cookie = "";
    let workspaceId = "";
    let threadId = "";
    const runIds: string[] = [];

    afterAll(async () => {
      for (const runId of runIds) {
        await deleteRunStream(runId).catch(() => undefined);
      }

      const workspaces = await prisma.workspace.findMany({
        where: { title: { startsWith: "IT-SseWs-" } },
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
        await prisma.thread.deleteMany({
          where: { id: { in: threadIds } },
        });
        await prisma.workspace.deleteMany({
          where: { id: { in: workspaceIds } },
        });
      }
      await prisma.user.deleteMany({ where: { email: userEmail } });
      await disconnectRedis();
      await prisma.$disconnect();
    });

    async function createRun(prompt: string): Promise<string> {
      const res = await app.request(`/api/threads/${threadId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ prompt }),
      });
      expect(res.status).toBe(200);
      const runId = (await res.json()).data.run.id as string;
      runIds.push(runId);
      return runId;
    }

    async function tokenFor(runId: string): Promise<string> {
      const run = await prisma.agentRun.findUniqueOrThrow({
        where: { id: runId },
      });
      return issueRunToken({
        userId: run.userId,
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        runId: run.id,
      });
    }

    async function postStreamChunk(
      runId: string,
      body: { chunk: string; streamType: "thinking" | "content" },
    ): Promise<string> {
      const res = await app.request("/api/ingest/stream-chunk", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${await tokenFor(runId)}`,
        },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      return (await res.json()).data.streamEntryId as string;
    }

    it("准备：注册用户，建 workspace + thread", async () => {
      cookie = await signUpAndGetCookie(app, userEmail);

      const wsRes = await app.request("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie },
        body: JSON.stringify({ title: "IT-SseWs-Main" }),
      });
      workspaceId = (await wsRes.json()).data.workspace.id;

      const threadRes = await app.request(
        `/api/workspaces/${workspaceId}/threads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ title: "IT-SseThread" }),
        },
      );
      threadId = (await threadRes.json()).data.thread.id;

      expect(workspaceId).toBeTruthy();
      expect(threadId).toBeTruthy();
    });

    it("rejects unauthenticated SSE request", async () => {
      const runId = await createRun("unauthenticated sse check");

      const res = await app.request(`/api/runs/${runId}/events`);

      expect(res.status).toBe(401);
    });

    it("snapshot includes existing historical events", async () => {
      const runId = await createRun("snapshot check");
      await insertRunEvent({
        runId,
        seq: 1,
        type: "run_created",
        payload: null,
      });
      await insertRunEvent({
        runId,
        seq: 2,
        type: "agent_message",
        content: "Historical answer",
        payload: { messageId: "msg_history" },
      });
      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: "completed" },
      });

      const res = await app.request(`/api/runs/${runId}/events`, {
        headers: { cookie },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const records = parseSseRecords(await res.text());
      const snapshot = records.find((record) => record.event === "snapshot");
      expect(snapshot).toBeTruthy();
      const data = JSON.parse(snapshot?.data ?? "{}");
      expect(data.events.map((event: { type: string }) => event.type)).toEqual([
        "run_created",
        "agent_message",
      ]);
    });

    it("POST SSE snapshot includes existing historical events", async () => {
      const runId = await createRun("post snapshot check");
      await insertRunEvent({
        runId,
        seq: 1,
        type: "run_created",
        payload: null,
      });
      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: "completed" },
      });

      const res = await app.request(`/api/runs/${runId}/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const records = parseSseRecords(await res.text());
      expect(records.map((record) => record.event)).toEqual([
        "snapshot",
        "done",
      ]);
      const snapshot = JSON.parse(records[0].data);
      expect(snapshot.events.map((event: { type: string }) => event.type)).toEqual([
        "run_created",
      ]);
    });

    it("active run streams new events as they're ingested", async () => {
      const runId = await createRun("active stream check");
      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: "running" },
      });

      const res = await app.request(`/api/runs/${runId}/events`, {
        headers: { cookie },
      });
      expect(res.status).toBe(200);

      await insertRunEvent({
        runId,
        seq: 1,
        type: "run_created",
        payload: null,
      });
      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: "completed" },
      });

      const { records } = await readSseUntil(
        res,
        (record) => record.event === "done",
      );
      const matched = records.find((record) => record.event === "run_created");

      expect(matched?.id).toBeUndefined();
      expect(JSON.parse(matched?.data ?? "{}").seq).toBe(1);
    });

    it("terminal run sends done after snapshot", async () => {
      const runId = await createRun("terminal done check");
      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: "completed" },
      });

      const res = await app.request(`/api/runs/${runId}/events`, {
        headers: { cookie },
      });

      const records = parseSseRecords(await res.text());
      expect(records.map((record) => record.event)).toEqual([
        "snapshot",
        "done",
      ]);
      expect(JSON.parse(records[1].data).status).toBe("completed");
    });

    it("waiting_for_input run sends snapshot with waitingForInput then done", async () => {
      const runId = await createRun("waiting for input check");
      await insertRunEvent({
        runId,
        seq: 1,
        type: "run_waiting_for_input",
        payload: { question: "Choose next step", options: ["A", "B"] },
      });
      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: "waiting_for_input" },
      });

      const res = await app.request(`/api/runs/${runId}/events`, {
        headers: { cookie },
      });

      const records = parseSseRecords(await res.text());
      expect(records.map((record) => record.event)).toEqual([
        "snapshot",
        "done",
      ]);
      const snapshot = JSON.parse(records[0].data);
      expect(snapshot.run.waitingForInput).toEqual({
        question: "Choose next step",
        options: ["A", "B"],
      });
      expect(JSON.parse(records[1].data).status).toBe("waiting_for_input");
    });

    it('new connection without Last-Event-ID reads full stream from start (cursor "0")', async () => {
      const runId = await createRun("full stream from start check");
      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: "running" },
      });
      const id1 = await postStreamChunk(runId, {
        chunk: "race-A",
        streamType: "thinking",
      });
      const id2 = await postStreamChunk(runId, {
        chunk: "race-B",
        streamType: "content",
      });

      const res = await app.request(`/api/runs/${runId}/events`, {
        headers: { cookie },
      });

      const { records } = await readSseUntil(
        res,
        (record) =>
          record.event === "stream_chunk" &&
          JSON.parse(record.data).chunk === "race-B",
      );
      const chunks = records.filter((record) => record.event === "stream_chunk");
      expect(chunks.map((record) => record.id)).toEqual([id1, id2]);
      expect(chunks.map((record) => JSON.parse(record.data).chunk)).toEqual([
        "race-A",
        "race-B",
      ]);
    });

    it("reconnect with Last-Event-ID resumes from correct cursor, no duplicate delivery", async () => {
      const runId = await createRun("last event id no duplicate check");
      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: "running" },
      });
      const id1 = await postStreamChunk(runId, {
        chunk: "cursor-A",
        streamType: "thinking",
      });
      const id2 = await postStreamChunk(runId, {
        chunk: "cursor-B",
        streamType: "thinking",
      });
      const id3 = await postStreamChunk(runId, {
        chunk: "cursor-C",
        streamType: "content",
      });

      const res = await app.request(`/api/runs/${runId}/events`, {
        headers: { cookie, "Last-Event-ID": id2 },
      });

      const { records } = await readSseUntil(
        res,
        (record) =>
          record.event === "stream_chunk" &&
          JSON.parse(record.data).chunk === "cursor-C",
      );
      const chunks = records.filter((record) => record.event === "stream_chunk");
      expect(chunks.map((record) => record.id)).toEqual([id3]);
      expect(chunks.map((record) => record.id)).not.toContain(id1);
      expect(chunks.map((record) => record.id)).not.toContain(id2);
    });

    it("POST reconnect with body lastEventId resumes from correct cursor", async () => {
      const runId = await createRun("post last event id no duplicate check");
      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: "running" },
      });
      const id1 = await postStreamChunk(runId, {
        chunk: "post-cursor-A",
        streamType: "thinking",
      });
      const id2 = await postStreamChunk(runId, {
        chunk: "post-cursor-B",
        streamType: "content",
      });

      const res = await app.request(`/api/runs/${runId}/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie,
        },
        body: JSON.stringify({ lastEventId: id1 }),
      });

      const { records } = await readSseUntil(
        res,
        (record) =>
          record.event === "stream_chunk" &&
          JSON.parse(record.data).chunk === "post-cursor-B",
      );
      const chunks = records.filter((record) => record.event === "stream_chunk");
      expect(chunks.map((record) => record.id)).toEqual([id2]);
      expect(chunks.map((record) => record.id)).not.toContain(id1);
    });

    it("reconnect with Last-Event-ID resumes through reconnect gap, no lost chunk", async () => {
      const runId = await createRun("last event id no lost chunk check");
      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: "running" },
      });

      const firstRes = await app.request(`/api/runs/${runId}/events`, {
        headers: { cookie },
      });
      const liveId = await postStreamChunk(runId, {
        chunk: "live-before-disconnect",
        streamType: "thinking",
      });
      const firstRead = await readSseUntil(
        firstRes,
        (record) =>
          record.event === "stream_chunk" &&
          JSON.parse(record.data).chunk === "live-before-disconnect",
      );
      expect(firstRead.matched.id).toBe(liveId);

      const gapId1 = await postStreamChunk(runId, {
        chunk: "gap-A",
        streamType: "thinking",
      });
      const gapId2 = await postStreamChunk(runId, {
        chunk: "gap-B",
        streamType: "content",
      });

      const reconnectRes = await app.request(`/api/runs/${runId}/events`, {
        headers: { cookie, "Last-Event-ID": liveId },
      });

      const { records } = await readSseUntil(
        reconnectRes,
        (record) =>
          record.event === "stream_chunk" &&
          JSON.parse(record.data).chunk === "gap-B",
      );
      const chunks = records.filter((record) => record.event === "stream_chunk");
      expect(chunks.map((record) => record.id)).toEqual([gapId1, gapId2]);
      expect(chunks.map((record) => JSON.parse(record.data).chunk)).toEqual(
        ["gap-A", "gap-B"],
      );
    });
  },
);

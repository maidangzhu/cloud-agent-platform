// API 路由集成测试 —— 真实 DB，runAgent 被 mock 掉（不触发真实 LLM）。
// 覆盖所有端点的 happy path + 主要错误路径 + 全链路场景。

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/db/client";

// ── mock runAgent（避免集成测试触发真实 LLM）──────────────────────────
vi.mock("@/server/agent/run-agent", () => ({
  runAgent: vi.fn().mockResolvedValue(undefined),
}));

// ── 动态导入 route handlers（mock 注册后才导入）────────────────────────
const { POST: invitePost } = await import("@/app/api/invite/route");
const { POST: sessionsPost } = await import("@/app/api/sessions/route");
const { GET: sessionGet } = await import("@/app/api/sessions/[id]/route");
const { POST: runsPost } = await import(
  "@/app/api/sessions/[id]/runs/route"
);
const { GET: runGet } = await import("@/app/api/runs/[runId]/route");
const { POST: cancelPost } = await import(
  "@/app/api/runs/[runId]/cancel/route"
);
const { GET: eventsGet, POST: eventsPost } = await import(
  "@/app/api/runs/[runId]/events/route"
);

// ── 辅助 ──────────────────────────────────────────────────────────────
const INVITE_CODE = "test-code-777";

function jsonReq(method: string, body: unknown) {
  return new Request("http://localhost", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── 测试数据清理 ───────────────────────────────────────────────────────
let sessionIds: string[] = [];

beforeAll(() => {
  process.env.INVITE_CODES = INVITE_CODE;
});

afterAll(async () => {
  if (sessionIds.length) {
    await prisma.session
      .deleteMany({ where: { id: { in: sessionIds } } })
      .catch(() => {});
  }
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/invite
// ══════════════════════════════════════════════════════════════════════
describe("POST /api/invite", () => {
  it("有效码 → 200 { code:0, valid:true }", async () => {
    const res = await invitePost(jsonReq("POST", { code: INVITE_CODE }));
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.code).toBe(0);
    expect(b.data.valid).toBe(true);
  });

  it("无效码 → 401 { code:1002 }", async () => {
    const res = await invitePost(jsonReq("POST", { code: "wrong" }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe(1002);
  });

  it("缺少 code → 400 { code:1001 }", async () => {
    const res = await invitePost(jsonReq("POST", {}));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe(1001);
  });

  it("非 JSON → 400", async () => {
    const res = await invitePost(
      new Request("http://localhost", { method: "POST", body: "not-json" }),
    );
    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/sessions
// ══════════════════════════════════════════════════════════════════════
describe("POST /api/sessions", () => {
  it("有效邀请码 → 201 返回 SessionDTO", async () => {
    const res = await sessionsPost(
      jsonReq("POST", { inviteCode: INVITE_CODE, prompt: "fix TODOs" }),
    );
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.code).toBe(0);
    expect(b.data.session.id).toBeTruthy();
    expect(b.data.session.title).toBe("fix TODOs");
    expect(b.data.session.status).toBe("active");
    sessionIds.push(b.data.session.id);
  });

  it("无 prompt → title 为 'New session'", async () => {
    const res = await sessionsPost(
      jsonReq("POST", { inviteCode: INVITE_CODE }),
    );
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.data.session.title).toBe("New session");
    sessionIds.push(b.data.session.id);
  });

  it("无效邀请码 → 401", async () => {
    const res = await sessionsPost(
      jsonReq("POST", { inviteCode: "bad-code" }),
    );
    expect(res.status).toBe(401);
  });

  it("缺少 inviteCode → 400", async () => {
    const res = await sessionsPost(jsonReq("POST", {}));
    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════════
// GET /api/sessions/:id
// ══════════════════════════════════════════════════════════════════════
describe("GET /api/sessions/:id", () => {
  let sid: string;

  beforeEach(async () => {
    const s = await prisma.session.create({
      data: { title: "test-session", status: "active" },
    });
    sid = s.id;
    sessionIds.push(sid);
  });

  it("存在 → 200 返回 session + messages + runs", async () => {
    const res = await sessionGet(new Request("http://localhost"), {
      params: Promise.resolve({ id: sid }),
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.code).toBe(0);
    expect(b.data.session.id).toBe(sid);
    expect(Array.isArray(b.data.messages)).toBe(true);
    expect(Array.isArray(b.data.runs)).toBe(true);
  });

  it("有消息时正确返回", async () => {
    await prisma.message.createMany({
      data: [
        { sessionId: sid, role: "user", content: "hello" },
        { sessionId: sid, role: "assistant", content: "hi" },
      ],
    });
    const res = await sessionGet(new Request("http://localhost"), {
      params: Promise.resolve({ id: sid }),
    });
    const b = await res.json();
    expect(b.data.messages).toHaveLength(2);
    expect(b.data.messages[0].role).toBe("user");
  });

  it("不存在 → 404 { code:1003 }", async () => {
    const res = await sessionGet(new Request("http://localhost"), {
      params: Promise.resolve({ id: "nonexistent-id" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe(1003);
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/sessions/:id/runs
// ══════════════════════════════════════════════════════════════════════
describe("POST /api/sessions/:id/runs", () => {
  let sid: string;

  beforeEach(async () => {
    const s = await prisma.session.create({
      data: { title: "runs-test", status: "active" },
    });
    sid = s.id;
    sessionIds.push(sid);
  });

  it("有效 prompt → 202 返回 RunDTO（status=created）", async () => {
    const res = await runsPost(jsonReq("POST", { prompt: "find bugs" }), {
      params: Promise.resolve({ id: sid }),
    });
    expect(res.status).toBe(202);
    const b = await res.json();
    expect(b.code).toBe(0);
    expect(b.data.run.sessionId).toBe(sid);
    expect(b.data.run.userPrompt).toBe("find bugs");
    expect(b.data.run.status).toBe("created");
    expect(b.data.run.derivedUiState).toBe("idle");
  });

  it("同时写入 user Message", async () => {
    await runsPost(jsonReq("POST", { prompt: "list files" }), {
      params: Promise.resolve({ id: sid }),
    });
    // 等 updateMany（fire-and-forget）有机会执行
    await new Promise((r) => setTimeout(r, 100));
    const msgs = await prisma.message.findMany({ where: { sessionId: sid } });
    expect(msgs.some((m) => m.role === "user" && m.content === "list files")).toBe(true);
  });

  it("session 不存在 → 404", async () => {
    const res = await runsPost(jsonReq("POST", { prompt: "x" }), {
      params: Promise.resolve({ id: "no-such-session" }),
    });
    expect(res.status).toBe(404);
  });

  it("缺少 prompt → 400", async () => {
    const res = await runsPost(jsonReq("POST", {}), {
      params: Promise.resolve({ id: sid }),
    });
    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════════
// GET /api/runs/:runId
// ══════════════════════════════════════════════════════════════════════
describe("GET /api/runs/:runId", () => {
  let sid: string;
  let runId: string;

  beforeEach(async () => {
    const s = await prisma.session.create({
      data: { title: "run-get-test", status: "active" },
    });
    sid = s.id;
    sessionIds.push(sid);
    const r = await prisma.run.create({
      data: { sessionId: sid, userPrompt: "find bugs" },
    });
    runId = r.id;
  });

  it("存在 → 200 返回 RunDetailData", async () => {
    const res = await runGet(new Request("http://localhost"), {
      params: Promise.resolve({ runId }),
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.code).toBe(0);
    expect(b.data.run.id).toBe(runId);
    expect(b.data.run.derivedUiState).toBe("idle"); // created → idle
    expect(Array.isArray(b.data.events)).toBe(true);
    expect(Array.isArray(b.data.toolCalls)).toBe(true);
    expect(Array.isArray(b.data.artifacts)).toBe(true);
  });

  it("有事件和工具调用时正确返回", async () => {
    await prisma.agentEvent.createMany({
      data: [
        { runId, seq: 0, type: "run_created" },
        { runId, seq: 1, type: "agent_started" },
      ],
    });
    await prisma.toolCall.create({
      data: { runId, eventSeq: 1, name: "list_files", args: {}, status: "completed" },
    });
    const res = await runGet(new Request("http://localhost"), {
      params: Promise.resolve({ runId }),
    });
    const b = await res.json();
    expect(b.data.events).toHaveLength(2);
    expect(b.data.toolCalls).toHaveLength(1);
    expect(b.data.toolCalls[0].name).toBe("list_files");
  });

  it("不存在 → 404", async () => {
    const res = await runGet(new Request("http://localhost"), {
      params: Promise.resolve({ runId: "no-such-run" }),
    });
    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/runs/:runId/cancel
// ══════════════════════════════════════════════════════════════════════
describe("POST /api/runs/:runId/cancel", () => {
  let sid: string;

  beforeEach(async () => {
    const s = await prisma.session.create({
      data: { title: "cancel-test", status: "active" },
    });
    sid = s.id;
    sessionIds.push(sid);
  });

  it("running → cancel_requested，返回更新后 RunDTO", async () => {
    const run = await prisma.run.create({
      data: { sessionId: sid, userPrompt: "x", status: "running" },
    });
    const res = await cancelPost(new Request("http://localhost"), {
      params: Promise.resolve({ runId: run.id }),
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.run.status).toBe("cancel_requested");
    expect(b.data.run.derivedUiState).toBe("cancelled");
  });

  it.each(["completed", "failed", "timeout", "cancelled"] as const)(
    "终态 %s → 409 { code:2001 }",
    async (status) => {
      const run = await prisma.run.create({
        data: { sessionId: sid, userPrompt: "x", status },
      });
      const res = await cancelPost(new Request("http://localhost"), {
        params: Promise.resolve({ runId: run.id }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe(2001);
    },
  );

  it("不存在 → 404", async () => {
    const res = await cancelPost(new Request("http://localhost"), {
      params: Promise.resolve({ runId: "no-such-run" }),
    });
    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════════
// POST /api/runs/:runId/events（SSE，fetch-event-source）
// ══════════════════════════════════════════════════════════════════════
describe("POST /api/runs/:runId/events (SSE)", () => {
  let sid: string;

  beforeEach(async () => {
    const s = await prisma.session.create({
      data: { title: "sse-test", status: "active" },
    });
    sid = s.id;
    sessionIds.push(sid);
  });

  async function readSSE(res: Response): Promise<Array<{ event: string; data: unknown }>> {
    const text = await res.text();
    const frames: Array<{ event: string; data: unknown }> = [];
    let currentEvent = "";
    for (const line of text.split("\n")) {
      if (line.startsWith("event: ")) currentEvent = line.slice(7).trim();
      else if (line.startsWith("data: ")) {
        frames.push({ event: currentEvent, data: JSON.parse(line.slice(6)) });
        currentEvent = "";
      }
    }
    return frames;
  }

  it("终态 run → 返回 text/event-stream，含 snapshot + done", async () => {
    const run = await prisma.run.create({
      data: { sessionId: sid, userPrompt: "test", status: "completed" },
    });
    await prisma.agentEvent.createMany({
      data: [
        { runId: run.id, seq: 0, type: "run_created" },
        { runId: run.id, seq: 1, type: "run_completed" },
      ],
    });

    const res = await eventsPost(new Request("http://localhost", { method: "POST" }), {
      params: Promise.resolve({ runId: run.id }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const frames = await readSSE(res);
    expect(frames[0].event).toBe("snapshot");
    expect((frames[0].data as any).run.id).toBe(run.id);
    expect((frames[0].data as any).events).toHaveLength(2);
    expect(frames.at(-1)?.event).toBe("done");
  });

  it("snapshot 含已有事件，run.derivedUiState 正确", async () => {
    const run = await prisma.run.create({
      data: { sessionId: sid, userPrompt: "x", status: "failed", error: "oops" },
    });
    const res = await eventsPost(new Request("http://localhost", { method: "POST" }), {
      params: Promise.resolve({ runId: run.id }),
    });
    const frames = await readSSE(res);
    expect((frames[0].data as any).run.status).toBe("failed");
    expect((frames[0].data as any).run.derivedUiState).toBe("failed");
  });

  it("run 不存在 → 404", async () => {
    const res = await eventsPost(new Request("http://localhost", { method: "POST" }), {
      params: Promise.resolve({ runId: "no-such" }),
    });
    expect(res.status).toBe(404);
  });

  it("GET 仍兼容旧 EventSource 客户端", async () => {
    const run = await prisma.run.create({
      data: { sessionId: sid, userPrompt: "legacy", status: "completed" },
    });

    const res = await eventsGet(new Request("http://localhost"), {
      params: Promise.resolve({ runId: run.id }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });
});

// ══════════════════════════════════════════════════════════════════════
// 全链路：创建 session → 触发 run → 预设事件 → 读取各端点
// ══════════════════════════════════════════════════════════════════════
describe("全链路：Session → Run → Events → Cancel 重建完整状态", () => {
  it("模拟一次完整执行并验证所有端点数据一致", async () => {
    // 1. 创建 session
    const s1Res = await sessionsPost(
      jsonReq("POST", { inviteCode: INVITE_CODE, prompt: "explore repo" }),
    );
    expect(s1Res.status).toBe(201);
    const sessionId = (await s1Res.json()).data.session.id;
    sessionIds.push(sessionId);

    // 2. 创建 run（runAgent 被 mock，不实际执行）
    const r1Res = await runsPost(jsonReq("POST", { prompt: "find TODOs" }), {
      params: Promise.resolve({ id: sessionId }),
    });
    expect(r1Res.status).toBe(202);
    const runId = (await r1Res.json()).data.run.id;

    // 3. 模拟 agent 执行：顺序写入（避免 Neon serverless 连接池下事务超时）
    await prisma.agentEvent.createMany({
      data: [
        { runId, seq: 0, type: "run_created" },
        { runId, seq: 1, type: "workspace_provisioning" },
        { runId, seq: 2, type: "workspace_ready" },
        { runId, seq: 3, type: "agent_started" },
        { runId, seq: 4, type: "tool_call_started", title: "search_text" },
        { runId, seq: 5, type: "tool_call_completed", title: "search_text" },
        { runId, seq: 6, type: "model_step", role: "assistant", content: "Found 3 TODOs." },
        { runId, seq: 7, type: "artifact_created", title: "Analysis Report" },
        { runId, seq: 8, type: "run_completed" },
      ],
    });
    await prisma.toolCall.create({
      data: {
        runId, eventSeq: 4, name: "search_text",
        args: { pattern: "TODO" },
        result: { content: [{ text: "3 matches" }] },
        status: "completed",
      },
    });
    await prisma.artifact.create({
      data: { runId, kind: "report", title: "Analysis Report", content: "## Found 3 TODOs\n..." },
    });
    await prisma.message.create({
      data: { sessionId, role: "assistant", content: "Found 3 TODOs.", runId },
    });
    await prisma.run.update({
      where: { id: runId },
      data: { status: "completed", completedAt: new Date() },
    });

    // 4. GET /api/runs/:runId → 验证完整数据
    const rdRes = await runGet(new Request("http://localhost"), {
      params: Promise.resolve({ runId }),
    });
    const rd = (await rdRes.json()).data;
    expect(rd.run.status).toBe("completed");
    expect(rd.run.derivedUiState).toBe("completed");
    expect(rd.events).toHaveLength(9);
    expect(rd.toolCalls).toHaveLength(1);
    expect(rd.toolCalls[0].name).toBe("search_text");
    expect(rd.artifacts).toHaveLength(1);
    expect(rd.artifacts[0].kind).toBe("report");

    // 5. GET /api/sessions/:id → 验证消息历史
    const sdRes = await sessionGet(new Request("http://localhost"), {
      params: Promise.resolve({ id: sessionId }),
    });
    const sd = (await sdRes.json()).data;
    expect(sd.messages.some((m: any) => m.role === "user")).toBe(true);
    expect(sd.messages.some((m: any) => m.role === "assistant")).toBe(true);
    expect(sd.runs).toHaveLength(1);
    expect(sd.runs[0].id).toBe(runId);

    // 6. POST /api/runs/:runId/events → SSE snapshot 含全部 9 个事件
    const sseRes = await eventsPost(new Request("http://localhost", { method: "POST" }), {
      params: Promise.resolve({ runId }),
    });
    const text = await sseRes.text();
    const snapshotLine = text.split("\n").find((l) => l.startsWith("data:") && l.includes('"snapshot"' + "")) ;
    // 找 snapshot frame 的 data
    const snapshotData = JSON.parse(
      text.match(/event: snapshot\ndata: (.+)/)?.[1] ?? "null",
    );
    expect(snapshotData?.events).toHaveLength(9);
    expect(snapshotData?.run.status).toBe("completed");

    // 7. POST /api/runs/:runId/cancel on completed → 409（已终态）
    const cancelRes = await cancelPost(new Request("http://localhost"), {
      params: Promise.resolve({ runId }),
    });
    expect(cancelRes.status).toBe(409);
    expect((await cancelRes.json()).code).toBe(2001);
  });

  it("取消链路：running run → cancel → derivedUiState=cancelled", async () => {
    const s = await prisma.session.create({
      data: { title: "cancel-chain", status: "active" },
    });
    sessionIds.push(s.id);
    const run = await prisma.run.create({
      data: {
        sessionId: s.id,
        userPrompt: "long task",
        status: "running",
        lastHeartbeatAt: new Date(),
      },
    });

    // 取消
    const res = await cancelPost(new Request("http://localhost"), {
      params: Promise.resolve({ runId: run.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.run.status).toBe("cancel_requested");
    expect(body.data.run.derivedUiState).toBe("cancelled");

    // GET run 也体现取消状态
    const getRun = await runGet(new Request("http://localhost"), {
      params: Promise.resolve({ runId: run.id }),
    });
    expect((await getRun.json()).data.run.derivedUiState).toBe("cancelled");
  });

  it("多轮对话：第二个 Run 能看到 Session 消息历史", async () => {
    const s = await prisma.session.create({
      data: { title: "multi-turn-chain", status: "active" },
    });
    sessionIds.push(s.id);

    // Run 1
    const r1Res = await runsPost(jsonReq("POST", { prompt: "hello" }), {
      params: Promise.resolve({ id: s.id }),
    });
    const run1Id = (await r1Res.json()).data.run.id;
    // 写 assistant 回复
    await prisma.message.create({
      data: { sessionId: s.id, role: "assistant", content: "hi there", runId: run1Id },
    });

    // Run 2
    const r2Res = await runsPost(jsonReq("POST", { prompt: "what did you say?" }), {
      params: Promise.resolve({ id: s.id }),
    });
    expect(r2Res.status).toBe(202);

    // Session 现在应有 ≥3 条消息（user1, assistant1, user2）
    const sdRes = await sessionGet(new Request("http://localhost"), {
      params: Promise.resolve({ id: s.id }),
    });
    const sd = await sdRes.json();
    expect(sd.data.messages.length).toBeGreaterThanOrEqual(2);
    expect(sd.data.runs).toHaveLength(2);
  });
});

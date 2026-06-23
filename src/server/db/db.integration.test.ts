import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "./client";

// 连真实 Neon Postgres。无 DATABASE_URL（如 CI 未配）则整组跳过，不报错。
// 运行：pnpm test:integration
const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("DB 集成 — 连接 + 7 表增删改查", () => {
  // 贯穿子表测试的脚手架：一个 Session + 一个 Run。
  let sessionId = "";
  let runId = "";

  beforeAll(async () => {
    const s = await prisma.session.create({
      data: { title: "integration-scaffold", inviteCodeHash: "hash" },
    });
    sessionId = s.id;
    const r = await prisma.run.create({
      data: { sessionId, userPrompt: "scaffold prompt" },
    });
    runId = r.id;
  });

  afterAll(async () => {
    // 删 Session 经 onDelete:Cascade 连带清掉 Workspace/Message/Run 及其
    // AgentEvent/ToolCall/Artifact，保持远端库干净。
    if (sessionId) {
      await prisma.session.deleteMany({ where: { id: sessionId } });
    }
    await prisma.$disconnect();
  });

  it("连接冒烟：SELECT 1", async () => {
    const rows = await prisma.$queryRaw<{ one: number }[]>`SELECT 1 as one`;
    expect(rows[0].one).toBe(1);
  });

  it("Session CRUD", async () => {
    const created = await prisma.session.create({ data: { title: "s-crud" } });
    expect(created.status).toBe("active"); // 默认值
    const read = await prisma.session.findUnique({ where: { id: created.id } });
    expect(read?.title).toBe("s-crud");
    const updated = await prisma.session.update({
      where: { id: created.id },
      data: { title: "s-crud-2", status: "archived" },
    });
    expect(updated.title).toBe("s-crud-2");
    expect(updated.status).toBe("archived");
    await prisma.session.delete({ where: { id: created.id } });
    expect(
      await prisma.session.findUnique({ where: { id: created.id } }),
    ).toBeNull();
  });

  it("Workspace CRUD（与 Session 1:1）", async () => {
    const created = await prisma.workspace.create({
      data: { sessionId, provider: "local", workingDir: "/tmp/ws" },
    });
    expect(created.status).toBe("pending");
    const read = await prisma.workspace.findUnique({
      where: { sessionId }, // sessionId @unique
    });
    expect(read?.id).toBe(created.id);
    const updated = await prisma.workspace.update({
      where: { id: created.id },
      data: { status: "ready", sandboxName: "sbx-1", snapshotId: "snap-1" },
    });
    expect(updated.status).toBe("ready");
    expect(updated.sandboxName).toBe("sbx-1");
    await prisma.workspace.delete({ where: { id: created.id } });
    expect(
      await prisma.workspace.findUnique({ where: { id: created.id } }),
    ).toBeNull();
  });

  it("Message CRUD（user / assistant）", async () => {
    const userMsg = await prisma.message.create({
      data: { sessionId, role: "user", content: "find TODOs" },
    });
    const asstMsg = await prisma.message.create({
      data: { sessionId, role: "assistant", content: "done", runId },
    });
    const list = await prisma.message.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" },
    });
    expect(list.length).toBeGreaterThanOrEqual(2);
    const updated = await prisma.message.update({
      where: { id: userMsg.id },
      data: { content: "find TODOs and FIXMEs" },
    });
    expect(updated.content).toBe("find TODOs and FIXMEs");
    await prisma.message.delete({ where: { id: userMsg.id } });
    await prisma.message.delete({ where: { id: asstMsg.id } });
    expect(
      await prisma.message.findUnique({ where: { id: userMsg.id } }),
    ).toBeNull();
  });

  it("Run CRUD", async () => {
    const created = await prisma.run.create({
      data: { sessionId, userPrompt: "p", maxSteps: 30 },
    });
    expect(created.status).toBe("created");
    expect(created.maxSteps).toBe(30);
    const read = await prisma.run.findUnique({ where: { id: created.id } });
    expect(read?.userPrompt).toBe("p");
    const now = new Date();
    const updated = await prisma.run.update({
      where: { id: created.id },
      data: { status: "running", startedAt: now, lastHeartbeatAt: now },
    });
    expect(updated.status).toBe("running");
    expect(updated.startedAt).not.toBeNull();
    await prisma.run.delete({ where: { id: created.id } });
    expect(
      await prisma.run.findUnique({ where: { id: created.id } }),
    ).toBeNull();
  });

  it("AgentEvent CRUD + @@unique([runId, seq]) 约束", async () => {
    const e0 = await prisma.agentEvent.create({
      data: { runId, seq: 0, type: "run_created" },
    });
    const e1 = await prisma.agentEvent.create({
      data: { runId, seq: 1, type: "agent_started", role: "assistant" },
    });
    // 同一 run 内 seq 唯一：重复插 seq=0 必须报错
    await expect(
      prisma.agentEvent.create({
        data: { runId, seq: 0, type: "model_step" },
      }),
    ).rejects.toThrow();

    const ordered = await prisma.agentEvent.findMany({
      where: { runId },
      orderBy: { seq: "asc" },
    });
    expect(ordered.map((e) => e.seq)).toEqual([0, 1]);

    const updated = await prisma.agentEvent.update({
      where: { id: e1.id },
      data: { content: "step output", title: "thinking" },
    });
    expect(updated.content).toBe("step output");

    await prisma.agentEvent.delete({ where: { id: e0.id } });
    await prisma.agentEvent.delete({ where: { id: e1.id } });
    expect(await prisma.agentEvent.count({ where: { runId } })).toBe(0);
  });

  it("ToolCall CRUD（args/result JSON）", async () => {
    const created = await prisma.toolCall.create({
      data: {
        runId,
        eventSeq: 5,
        name: "search_text",
        args: { query: "TODO", path: "." },
      },
    });
    expect(created.status).toBe("pending");
    const read = await prisma.toolCall.findUnique({
      where: { id: created.id },
    });
    expect((read?.args as { query: string }).query).toBe("TODO");
    const updated = await prisma.toolCall.update({
      where: { id: created.id },
      data: {
        status: "completed",
        result: { matches: 3 },
        completedAt: new Date(),
      },
    });
    expect(updated.status).toBe("completed");
    expect((updated.result as { matches: number }).matches).toBe(3);
    await prisma.toolCall.delete({ where: { id: created.id } });
    expect(
      await prisma.toolCall.findUnique({ where: { id: created.id } }),
    ).toBeNull();
  });

  it("Artifact CRUD（report）", async () => {
    const created = await prisma.artifact.create({
      data: {
        runId,
        kind: "report",
        title: "TODO Report",
        path: "REPORT.md",
        content: "# TODOs\n- a",
        metadata: { count: 1 },
      },
    });
    const read = await prisma.artifact.findUnique({
      where: { id: created.id },
    });
    expect(read?.kind).toBe("report");
    const updated = await prisma.artifact.update({
      where: { id: created.id },
      data: { content: "# TODOs\n- a\n- b" },
    });
    expect(updated.content).toContain("- b");
    await prisma.artifact.delete({ where: { id: created.id } });
    expect(
      await prisma.artifact.findUnique({ where: { id: created.id } }),
    ).toBeNull();
  });

  it("级联删除：删 Session 连带清空子表", async () => {
    const s = await prisma.session.create({ data: { title: "cascade" } });
    const r = await prisma.run.create({
      data: { sessionId: s.id, userPrompt: "x" },
    });
    await prisma.agentEvent.create({
      data: { runId: r.id, seq: 0, type: "run_created" },
    });
    await prisma.message.create({
      data: { sessionId: s.id, role: "user", content: "x" },
    });
    await prisma.session.delete({ where: { id: s.id } });
    expect(await prisma.run.count({ where: { sessionId: s.id } })).toBe(0);
    expect(await prisma.agentEvent.count({ where: { runId: r.id } })).toBe(0);
    expect(await prisma.message.count({ where: { sessionId: s.id } })).toBe(0);
  });
});

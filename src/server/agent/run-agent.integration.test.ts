// run-agent 集成测试（真实 LLM 中转站 + 真沙箱 + 真 DB）
// 3.3 happy path / 3.5 多轮上下文 / 3.6 failed、timeout、cancelled
// 运行：pnpm test:integration（需 OPENAI_API_KEY + Vercel 凭据 + DATABASE_URL）
//
// 不再用 faux：LLM 由真实中转站驱动，故 happy path 断言放宽为
// 「有工具调用 + 有报告 + run=completed」，不强求模型具体调哪个工具。
// 确定性边界（timeout/cancelled/failed）由编排层而非脚本化 LLM 触发。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../db/client";
import { resolveVercelCredentials } from "../sandbox/vercel-credentials";
import { runAgent } from "./run-agent";

const hasCreds =
  !!resolveVercelCredentials() &&
  !!process.env.DATABASE_URL &&
  !!process.env.OPENAI_API_KEY?.trim();

// 全组共享一个 Session（同一命名沙箱），避免每用例冷启动
describe.skipIf(!hasCreds)("run-agent 集成（真实 LLM + 真沙箱 + 真 DB）", () => {
  let sessionId: string;

  beforeAll(async () => {
    const session = await prisma.session.create({
      data: { title: "run-agent-it", status: "active" },
    });
    sessionId = session.id;
  });

  afterAll(async () => {
    await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
  });

  // ─── 3.3 happy path ─────────────────────────────────────────────────────────
  it("happy path: 探索仓库 → 工具调用 → 最终报告 → run completed + assistant Message", async () => {
    const prompt = "Find all TODO and FIXME comments in this repository and summarize them.";
    const run = await prisma.run.create({ data: { sessionId, userPrompt: prompt } });
    // 调用方负责写 user Message（runId 关联当前 run）
    await prisma.message.create({
      data: { sessionId, role: "user", content: prompt, runId: run.id },
    });

    await runAgent({ runId: run.id, sessionId, userPrompt: prompt });

    const updated = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(updated.status).toBe("completed");
    expect(updated.completedAt).not.toBeNull();

    const events = await prisma.agentEvent.findMany({
      where: { runId: run.id },
      orderBy: { seq: "asc" },
    });
    const types = events.map((e) => e.type);
    // 编排层必产生的生命周期事件
    expect(types).toContain("run_created");
    expect(types).toContain("workspace_provisioning");
    expect(types).toContain("agent_started");
    expect(types).toContain("model_step");
    expect(types).toContain("artifact_created");
    expect(types).toContain("run_completed");
    // 真实 LLM 应至少调用一次工具来探索仓库
    expect(types).toContain("tool_call_started");
    expect(types).toContain("tool_call_completed");

    // 至少有一个工具调用成功落库
    const toolCall = await prisma.toolCall.findFirst({
      where: { runId: run.id, status: "completed" },
    });
    expect(toolCall).not.toBeNull();

    // 报告 artifact + assistant Message 已写入
    const artifact = await prisma.artifact.findFirst({ where: { runId: run.id } });
    expect(artifact?.kind).toBe("report");
    expect(artifact?.content?.length ?? 0).toBeGreaterThan(0);

    const msg = await prisma.message.findFirst({
      where: { sessionId, role: "assistant" },
      orderBy: { createdAt: "desc" },
    });
    expect(msg?.content?.length ?? 0).toBeGreaterThan(0);
    expect(msg?.runId).toBe(run.id);
  });

  // ─── 3.5 多轮上下文 ──────────────────────────────────────────────────────────
  it("多轮：第二轮 Run 能看到第一轮历史 + 复用 workspace 文件", async () => {
    // Run1：让 agent 写一个文件
    const prompt1 =
      "Write a file at notes/session-note.txt with exactly the content: hello from run1. Then confirm it is written.";
    const run1 = await prisma.run.create({ data: { sessionId, userPrompt: prompt1 } });
    await prisma.message.create({
      data: { sessionId, role: "user", content: prompt1, runId: run1.id },
    });
    await runAgent({ runId: run1.id, sessionId, userPrompt: prompt1 });
    expect((await prisma.run.findUniqueOrThrow({ where: { id: run1.id } })).status).toBe(
      "completed",
    );

    // 文件确实写进了沙箱（验证 workspace 文件延续）
    const { sandbox } = await (await import("../sandbox/factory")).getOrCreateSandbox({
      sessionId,
    });
    const content = await sandbox.readFile("notes/session-note.txt");
    expect(content).toContain("hello from run1");
    await sandbox.stop();

    // Run2：历史消息应已落库（run1 的 user + assistant），供下一轮上下文加载
    const historyBeforeRun2 = await prisma.message.findMany({
      where: { sessionId, NOT: { runId: { equals: null } } },
    });
    // run1 至少写入了 user + assistant 两条
    expect(historyBeforeRun2.length).toBeGreaterThanOrEqual(2);

    const prompt2 = "What did you just write to the notes file in the previous turn?";
    const run2 = await prisma.run.create({ data: { sessionId, userPrompt: prompt2 } });
    await prisma.message.create({
      data: { sessionId, role: "user", content: prompt2, runId: run2.id },
    });
    await runAgent({ runId: run2.id, sessionId, userPrompt: prompt2 });
    expect((await prisma.run.findUniqueOrThrow({ where: { id: run2.id } })).status).toBe(
      "completed",
    );

    // 第二轮的 assistant 回答应提到上一轮写的内容（带历史上下文的证据）
    const run2Msg = await prisma.message.findFirst({
      where: { sessionId, role: "assistant", runId: run2.id },
    });
    expect(run2Msg?.content?.toLowerCase()).toContain("hello from run1".toLowerCase());
  });

  // ─── 3.6 失败 / 超限 / 取消 ──────────────────────────────────────────────────
  it("failed：LLM 端点不可达 → run 置 failed（事件保留）", async () => {
    // 临时把 baseUrl 指向不可达端点，制造系统级错误
    const original = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = "https://127.0.0.1:1/v1";
    try {
      const run = await prisma.run.create({ data: { sessionId, userPrompt: "fail test" } });
      await prisma.message.create({
        data: { sessionId, role: "user", content: "fail test", runId: run.id },
      });
      await runAgent({ runId: run.id, sessionId, userPrompt: "fail test" });

      const updated = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
      expect(updated.status).toBe("failed");
      expect(updated.error).toBeTruthy();

      const events = await prisma.agentEvent.findMany({ where: { runId: run.id } });
      expect(events.some((e) => e.type === "run_failed")).toBe(true);
      // 失败前已落的事件要保留
      expect(events.length).toBeGreaterThan(0);
    } finally {
      process.env.OPENAI_BASE_URL = original;
    }
  });

  it("timeout：maxSteps=1 → 第一轮后 abort → timeout", async () => {
    const prompt =
      "Explore this repository thoroughly: list files, read several files, and search for patterns. Use multiple tools across multiple turns.";
    const run = await prisma.run.create({ data: { sessionId, userPrompt: prompt } });
    await prisma.message.create({
      data: { sessionId, role: "user", content: prompt, runId: run.id },
    });
    // maxSteps=1：agent 跑完第一轮后，prepareNextTurn 在第二轮前 abort → timeout
    await runAgent({ runId: run.id, sessionId, userPrompt: prompt, maxSteps: 1 });

    const updated = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(updated.status).toBe("timeout");

    const events = await prisma.agentEvent.findMany({ where: { runId: run.id } });
    expect(events.some((e) => e.type === "run_timeout")).toBe(true);
  });

  it("cancelled：run 预先置 cancel_requested → 立即 cancelled（事件保留）", async () => {
    const run = await prisma.run.create({
      data: { sessionId, userPrompt: "cancel test", status: "cancel_requested" },
    });
    await prisma.message.create({
      data: { sessionId, role: "user", content: "cancel test", runId: run.id },
    });
    await runAgent({ runId: run.id, sessionId, userPrompt: "cancel test" });

    const updated = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(updated.status).toBe("cancelled");

    const events = await prisma.agentEvent.findMany({
      where: { runId: run.id },
      orderBy: { seq: "asc" },
    });
    expect(events.some((e) => e.type === "run_cancelled")).toBe(true);
    // 取消前已落的事件也要保留
    expect(events.length).toBeGreaterThan(0);
  });
});

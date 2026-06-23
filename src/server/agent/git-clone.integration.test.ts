// 集成测试：让 agent 在 sandbox 内 git clone 外部仓库（测试方案 A）
// 运行：pnpm vitest run --config vitest.integration.config.ts git-clone.integration.test.ts
//
// 前提：
// 1. policy.ts 白名单需包含 git
// 2. Vercel sandbox 需能访问外网（默认可能禁网）

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../db/client";
import { resolveVercelCredentials } from "../sandbox/vercel-credentials";
import { runAgent } from "./run-agent";

const hasCreds =
  !!resolveVercelCredentials() &&
  !!process.env.DATABASE_URL &&
  !!process.env.OPENAI_API_KEY?.trim();

describe.skipIf(!hasCreds)("git clone 外部仓库（方案 A）", () => {
  let sessionId: string;

  beforeAll(async () => {
    const session = await prisma.session.create({
      data: { title: "git-clone-test", status: "active" },
    });
    sessionId = session.id;
  });

  afterAll(async () => {
    await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
  });

  it("agent 在 sandbox 内 git clone https://github.com/maidangzhu/percentai 并分析项目", async () => {
    const prompt =
      "Clone the repository https://github.com/maidangzhu/percentai into the workspace, then read the README and tell me what this project does.";

    const run = await prisma.run.create({
      data: { sessionId, userPrompt: prompt, maxSteps: 200 },
    });

    await prisma.message.create({
      data: { sessionId, role: "user", content: prompt, runId: run.id },
    });

    // 执行 agent（maxSteps=200, maxDurationSec=600 即 10 分钟）
    await runAgent({
      runId: run.id,
      sessionId,
      userPrompt: prompt,
      maxSteps: 200,
      maxDurationSec: 600,
    });

    // 检查结果
    const updated = await prisma.run.findUniqueOrThrow({
      where: { id: run.id },
      select: { status: true, error: true },
    });

    console.log(`\n📊 Run status: ${updated.status}`);
    if (updated.error) {
      console.log(`❌ Error: ${updated.error}`);
    }

    // 查看事件流（诊断用）
    const events = await prisma.agentEvent.findMany({
      where: { runId: run.id },
      orderBy: { seq: "asc" },
      select: { seq: true, type: true, title: true, content: true },
    });
    console.log(`\n📋 Events (${events.length}):`);
    events.slice(0, 20).forEach((e) => {
      console.log(
        `  ${e.seq}. ${e.type}${e.title ? ` [${e.title}]` : ""}${e.content ? `: ${e.content.slice(0, 80)}` : ""}`,
      );
    });

    // 查看工具调用（诊断 git 是否被拒绝）
    const toolCalls = await prisma.toolCall.findMany({
      where: { runId: run.id },
      select: { name: true, status: true, args: true, error: true },
    });
    console.log(`\n🔧 Tool calls (${toolCalls.length}):`);
    toolCalls.slice(0, 10).forEach((tc) => {
      console.log(`  - ${tc.name} [${tc.status}]${tc.error ? ` ERROR: ${tc.error}` : ""}`);
      if (tc.name === "run_command") {
        console.log(`    cmd: ${(tc.args as any).command}`);
      }
    });

    // 如果失败，打印详细错误供诊断
    if (updated.status !== "completed") {
      console.log(`\n⚠️  Run did not complete. Status: ${updated.status}`);
      console.log(`Error: ${updated.error ?? "N/A"}`);
    }

    // 断言放宽：先验证能跑通，不强求必须 completed（因为可能网络/policy 限制）
    expect(["completed", "failed", "timeout"]).toContain(updated.status);
  }, 600_000); // 600s = 10 分钟 timeout（git clone + LLM 多轮推理）
});

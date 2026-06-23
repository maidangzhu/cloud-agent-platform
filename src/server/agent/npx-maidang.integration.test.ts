// 集成测试：让 agent 在 sandbox 内执行 npx maidang
// 运行：pnpm vitest run --config vitest.integration.config.ts npx-maidang.integration.test.ts

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../db/client";
import { resolveVercelCredentials } from "../sandbox/vercel-credentials";
import { runAgent } from "./run-agent";

const hasCreds =
  !!resolveVercelCredentials() &&
  !!process.env.DATABASE_URL &&
  !!process.env.OPENAI_API_KEY?.trim();

describe.skipIf(!hasCreds)("npx maidang 测试", () => {
  let sessionId: string;

  beforeAll(async () => {
    const session = await prisma.session.create({
      data: { title: "npx-maidang-test", status: "active" },
    });
    sessionId = session.id;
  });

  afterAll(async () => {
    await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
  });

  it("agent 执行 npx maidang 并总结文章内容与优势", async () => {
    const prompt =
      "Execute the command 'npx maidang' in the workspace to see what articles maidang has written recently. Then summarize the content and tell me what advantages maidang has.";

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

    // 查看事件流
    const events = await prisma.agentEvent.findMany({
      where: { runId: run.id },
      orderBy: { seq: "asc" },
      select: { seq: true, type: true, title: true, content: true },
    });
    console.log(`\n📋 Events (${events.length}):`);
    events.slice(0, 30).forEach((e) => {
      console.log(
        `  ${e.seq}. ${e.type}${e.title ? ` [${e.title}]` : ""}${e.content ? `: ${e.content.slice(0, 100)}` : ""}`,
      );
    });

    // 查看工具调用
    const toolCalls = await prisma.toolCall.findMany({
      where: { runId: run.id },
      orderBy: { startedAt: "asc" },
      select: { name: true, status: true, args: true, error: true, result: true },
    });
    console.log(`\n🔧 Tool calls (${toolCalls.length}):`);
    toolCalls.slice(0, 15).forEach((tc) => {
      console.log(`  - ${tc.name} [${tc.status}]`);
      if (tc.name === "run_command") {
        console.log(`    cmd: ${(tc.args as any).command}`);
      }
      if (tc.error) {
        console.log(`    ❌ ${tc.error.slice(0, 200)}`);
      }
      if (tc.status === "completed" && tc.result) {
        const result = tc.result as any;
        const text = result.content?.[0]?.text || JSON.stringify(result).slice(0, 200);
        console.log(`    ✅ ${text.slice(0, 300)}`);
      }
    });

    // 查看最终报告
    const artifact = await prisma.artifact.findFirst({
      where: { runId: run.id },
      select: { content: true },
    });
    if (artifact) {
      console.log(`\n📄 Report:\n${artifact.content}`);
    }

    // 断言
    expect(["completed", "failed", "timeout"]).toContain(updated.status);
  }, 600_000); // 10 分钟
});

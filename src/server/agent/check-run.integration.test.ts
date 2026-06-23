// 诊断：查看 maidang-multiturn session 的所有 Run 和工具调用
import { describe, it, expect } from "vitest";
import { prisma } from "../db/client";

describe("诊断 maidang-multiturn", () => {
  it("查看所有 Run 的工具调用", async () => {
    const session = await prisma.session.findFirst({
      where: { title: "maidang-multiturn" },
    });
    if (!session) { expect(session).toBeTruthy(); return; }

    const runs = await prisma.run.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: "asc" },
    });

    const result = await Promise.all(runs.map(async (run) => {
      const toolCalls = await prisma.toolCall.findMany({ where: { runId: run.id } });
      return {
        prompt: run.userPrompt.slice(0, 60),
        status: run.status,
        tools: toolCalls.map(tc => ({
          name: tc.name,
          status: tc.status,
          command: tc.name === "run_command" ? (tc.args as any).command : undefined,
          path: tc.name !== "run_command" ? (tc.args as any).path : undefined,
        })),
      };
    }));

    result.forEach((r, i) => {
      process.stdout.write(`\nTurn ${i+1}: ${r.prompt}\nStatus: ${r.status}\nTools:\n`);
      r.tools.forEach(t => process.stdout.write(`  ${t.name}[${t.status}] ${t.command || t.path || ""}\n`));
    });

    expect(result.length).toBe(999); // 故意失败以显示输出
  });
});


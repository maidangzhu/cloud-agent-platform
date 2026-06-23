// 查看 maidang-multiturn session 的完整 AI 执行过程
// 运行：pnpm vitest run --config vitest.integration.config.ts maidang-multiturn-viewer.integration.test.ts
// 需要先跑过 maidang-multiturn.integration.test.ts（会在 afterAll 删 session，所以要去掉 afterAll 或先改成保留）
// 这个 viewer 会直接查最新一次 title=maidang-multiturn 的 session

import { describe, it, expect } from "vitest";
import { prisma } from "../db/client";

const SEP = "─".repeat(72);

describe("maidang-multiturn 完整执行过程", () => {
  it("输出全部 Turn 的消息 + 工具调用 + 事件流", async () => {
    // 找最近一个 maidang-multiturn session（可能已被 afterAll 删掉，需先保留）
    const session = await prisma.session.findFirst({
      where: { title: "maidang-multiturn" },
      orderBy: { createdAt: "desc" },
    });
    if (!session) {
      process.stdout.write("\n❌ 未找到 maidang-multiturn session。\n");
      process.stdout.write("   请先把 maidang-multiturn.integration.test.ts 的 afterAll 改成保留，\n");
      process.stdout.write("   或者直接跑：pnpm vitest run --config vitest.integration.config.ts src/server/agent/maidang-multiturn.integration.test.ts\n\n");
      expect(session).not.toBeNull();
      return;
    }

    const runs = await prisma.run.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: "asc" },
    });

    process.stdout.write(`\n${"═".repeat(72)}\n`);
    process.stdout.write(`SESSION: ${session.id}  (${runs.length} turns)\n`);
    process.stdout.write(`${"═".repeat(72)}\n`);

    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      process.stdout.write(`\n${"━".repeat(72)}\n`);
      process.stdout.write(`TURN ${i + 1}  run=${run.id}  status=${run.status}\n`);
      process.stdout.write(`USER: ${run.userPrompt}\n`);
      process.stdout.write(`${"━".repeat(72)}\n`);

      // 该 Turn 的所有事件（按 seq 排序）
      const events = await prisma.agentEvent.findMany({
        where: { runId: run.id },
        orderBy: { seq: "asc" },
      });

      // 该 Turn 的工具调用（按 eventSeq 排序）
      const toolCalls = await prisma.toolCall.findMany({
        where: { runId: run.id },
        orderBy: { eventSeq: "asc" },
      });
      const tcBySeq = new Map(toolCalls.map((tc) => [tc.eventSeq, tc]));

      for (const ev of events) {
        switch (ev.type) {
          case "run_created":
          case "workspace_provisioning":
          case "workspace_ready":
          case "workspace_resumed":
          case "agent_started":
            process.stdout.write(`\n[${ev.seq}] ⚙️  ${ev.type}\n`);
            break;

          case "model_step":
            process.stdout.write(`\n[${ev.seq}] 🤖 AI说：\n`);
            process.stdout.write(`${ev.content ?? "(无文本)"}\n`);
            break;

          case "tool_call_started": {
            const tc = tcBySeq.get(ev.seq);
            process.stdout.write(`\n[${ev.seq}] 🔧 调用工具：${ev.title ?? tc?.name}\n`);
            if (tc) {
              const args = tc.args as Record<string, unknown>;
              if (tc.name === "run_command") {
                process.stdout.write(`   $ ${args.command}\n`);
              } else if (tc.name === "write_file") {
                process.stdout.write(`   path: ${args.path}\n`);
                const content = String(args.content ?? "");
                process.stdout.write(`   content (前200字):\n${content.slice(0, 200)}${content.length > 200 ? "\n   ..." : ""}\n`);
              } else if (tc.name === "read_file") {
                process.stdout.write(`   path: ${args.path}\n`);
              } else {
                process.stdout.write(`   args: ${JSON.stringify(args).slice(0, 120)}\n`);
              }
            }
            break;
          }

          case "tool_call_completed": {
            // 找对应的 started 事件（toolCallId 通过 raw 字段）
            const raw = ev.raw as Record<string, unknown> | null;
            const tcId = raw?.toolCallId as string | undefined;
            const tc = toolCalls.find((t) => {
              const startedRaw = events.find(
                (e) => e.type === "tool_call_started" && (e.raw as any)?.toolCallId === tcId
              );
              return startedRaw !== undefined;
            }) ?? toolCalls.find((t) => t.eventSeq < ev.seq);
            if (tc?.result) {
              const result = tc.result as any;
              const text = result.content?.[0]?.text ?? JSON.stringify(result);
              process.stdout.write(`   ✅ 结果 (前300字):\n   ${text.slice(0, 300).replace(/\n/g, "\n   ")}${text.length > 300 ? "\n   ..." : ""}\n`);
            }
            break;
          }

          case "tool_call_failed":
            process.stdout.write(`   ❌ 工具失败\n`);
            break;

          case "artifact_created":
            process.stdout.write(`\n[${ev.seq}] 📄 artifact created: ${ev.title}\n`);
            break;

          case "run_completed":
            process.stdout.write(`\n[${ev.seq}] ✅ run_completed\n`);
            break;

          case "run_failed":
          case "run_timeout":
          case "run_cancelled":
            process.stdout.write(`\n[${ev.seq}] ❌ ${ev.type}${ev.content ? `: ${ev.content.slice(0, 100)}` : ""}\n`);
            break;
        }
      }

      // 该 Turn 的 assistant 消息
      const assistantMsg = await prisma.message.findFirst({
        where: { sessionId: session.id, role: "assistant", runId: run.id },
        orderBy: { createdAt: "desc" },
      });
      if (assistantMsg) {
        process.stdout.write(`\n${SEP}\n`);
        process.stdout.write(`ASSISTANT 最终回复：\n${assistantMsg.content}\n`);
      }
    }

    process.stdout.write(`\n${"═".repeat(72)}\n`);

    // 故意失败以显示 stdout（vitest 默认吞掉 passed test 的输出）
    expect(true).toBe(false);
  });
});

// 多轮对话集成测试：用 npx maidang 探索麦当，最终让 AI 把 2025 歌单写进 workspace。
// 三轮 Run 共用同一 Session（同一沙箱），验证：
//   1. 多轮历史上下文传递（Turn 2 能引用 Turn 1 的结论）
//   2. 工具调用 npx（宽松 policy 放行）
//   3. workspace 文件写入（write_file 工具）
//   4. 会话内沙箱复用（Turn 3 能访问 Turn 1/2 写的文件）
//
// Eval：Turn 3 结束后沙箱里 notes/maidang-2025-songs.md 存在且包含歌曲信息。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../db/client";
import { resolveVercelCredentials } from "../sandbox/vercel-credentials";
import { getOrCreateSandbox } from "../sandbox/factory";
import { runAgent } from "./run-agent";

const hasCreds =
  !!resolveVercelCredentials() &&
  !!process.env.DATABASE_URL &&
  !!process.env.OPENAI_API_KEY?.trim();

/** 创建 Run + user Message，然后执行 agent。 */
async function doRun(sessionId: string, prompt: string) {
  const run = await prisma.run.create({ data: { sessionId, userPrompt: prompt } });
  await prisma.message.create({
    data: { sessionId, role: "user", content: prompt, runId: run.id },
  });
  await runAgent({ runId: run.id, sessionId, userPrompt: prompt, maxSteps: 30, maxDurationSec: 300 });
  return prisma.run.findUniqueOrThrow({ where: { id: run.id } });
}

describe.skipIf(!hasCreds)("多轮对话：npx maidang → 2025 歌单 → 写文件", () => {
  let sessionId: string;

  beforeAll(async () => {
    const session = await prisma.session.create({
      data: { title: "maidang-multiturn", status: "active" },
    });
    sessionId = session.id;
  });

  // afterAll 保留 session（方便 viewer 查看），只在明确清理时删除
  afterAll(async () => {
    // 不删除 session，供 maidang-multiturn-viewer.integration.test.ts 使用
    // 如需清理：pnpm vitest run --config vitest.integration.config.ts maidang-multiturn-viewer.integration.test.ts
  });

  // ─── Turn 1: 了解 maidang 是谁 ─────────────────────────────────────────────
  it("Turn 1: 执行 npx maidang whoami --json，了解 maidang 是谁", async () => {
    const run = await doRun(
      sessionId,
      "Use the run_command tool to execute `npx maidang whoami --json` and tell me who maidang is based on the output.",
    );

    expect(run.status).toBe("completed");

    // assistant 应给出关于 maidang 的回复
    const assistantMsg = await prisma.message.findFirst({
      where: { sessionId, role: "assistant", runId: run.id },
    });
    expect(assistantMsg?.content?.length ?? 0).toBeGreaterThan(0);
  }, 300_000);

  // ─── Turn 2: 问 2025 歌单 ──────────────────────────────────────────────────
  it("Turn 2: 执行 npx maidang songs --year 2025 --json，获取 2025 歌单", async () => {
    const run = await doRun(
      sessionId,
      "Use the run_command tool to execute `npx maidang songs --year 2025 --json` and tell me maidang's favorite songs in 2025.",
    );

    expect(run.status).toBe("completed");

    // assistant 应给出包含歌曲信息的回复
    const assistantMsg = await prisma.message.findFirst({
      where: { sessionId, role: "assistant", runId: run.id },
    });
    expect(assistantMsg?.content?.length ?? 0).toBeGreaterThan(0);
  }, 300_000);

  // ─── Turn 3: 写文件到 workspace ────────────────────────────────────────────
  it("Turn 3: 把 2025 歌单写入 workspace 文件，并验证文件存在", async () => {
    const run = await doRun(
      sessionId,
      "Write a markdown file at notes/maidang-2025-songs.md that records all of maidang's 2025 favorite songs. Include the song name and artist for each track.",
    );

    expect(run.status).toBe("completed");

    // 验证调用了 write_file
    const toolCalls = await prisma.toolCall.findMany({ where: { runId: run.id } });
    const writeCall = toolCalls.find((tc) => tc.name === "write_file");
    expect(writeCall, "应该调用 write_file 工具").toBeTruthy();
    expect(writeCall?.status).toBe("completed");

    // ── 核心 eval：读取 sandbox 文件验证内容 ──
    const { sandbox } = await getOrCreateSandbox({ sessionId });
    let fileContent: string;
    try {
      fileContent = await sandbox.readFile("notes/maidang-2025-songs.md");
    } finally {
      await sandbox.stop();
    }

    // 文件必须存在且非空
    expect(fileContent.length).toBeGreaterThan(0);

    // 文件内容应包含 2025 歌单的歌曲信息（曹方是 2025 歌单里的真实歌手）
    const hasArtistOrSong = /曹方|My Chemical Romance|张玉华|逃走鮑伯|2025/i.test(fileContent);
    expect(hasArtistOrSong, `文件内容未包含预期歌曲信息:\n${fileContent.slice(0, 300)}`).toBe(true);
  }, 300_000);
});

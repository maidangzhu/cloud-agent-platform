import { prisma } from "@/server/db/client";
import { toRunDTO } from "@/server/runs/run-service";
import { runAgent } from "@/server/agent/run-agent";
import { ApiCode, apiJson, fail, ok } from "@/lib/api-contract";
import type { CreateRunData } from "@/lib/api-contract";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: sessionId } = await params;

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) {
    const f = fail(ApiCode.NOT_FOUND, "Session not found");
    return apiJson(f.body, f.status);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    const f = fail(ApiCode.BAD_REQUEST, "invalid JSON");
    return apiJson(f.body, f.status);
  }

  const { prompt } = (body as any) ?? {};
  if (typeof prompt !== "string" || !prompt.trim()) {
    const f = fail(ApiCode.BAD_REQUEST, "prompt is required");
    return apiJson(f.body, f.status);
  }

  const userPrompt = prompt.trim();
  const runId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const now = new Date();

  // 建 Run + 写 user Message（原子操作）
  const [run] = await prisma.$transaction([
    prisma.run.create({
      data: {
        id: runId,
        sessionId,
        userPrompt,
        updatedAt: now,
      },
    }),
    prisma.message.create({
      data: {
        id: messageId,
        sessionId,
        role: "user",
        content: userPrompt,
      },
    }),
  ]);

  // 异步触发 agent loop（fire-and-forget，不阻塞响应）
  // 把 runId 更新进 user Message
  prisma.message.updateMany({
    where: { sessionId, role: "user", content: userPrompt, runId: null },
    data: { runId: run.id },
  }).then(() =>
    runAgent({ runId: run.id, sessionId, userPrompt })
  ).catch((err) => {
    console.error("[run-agent background error]", err);
    prisma.run.update({
      where: { id: run.id },
      data: { status: "failed", error: String(err), completedAt: new Date() },
    }).catch(() => {});
  });

  return apiJson(ok<CreateRunData>({ run: toRunDTO(run) }), 202);
}

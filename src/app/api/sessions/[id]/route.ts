import { prisma } from "@/server/db/client";
import { toMessageDTO, toRunDTO, toSessionDTO, toAgentEventDTO } from "@/server/runs/run-service";
import { ApiCode, apiJson, fail, ok } from "@/lib/api-contract";
import type { SessionDetailData, SessionDTO } from "@/lib/api-contract";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const session = await prisma.session.findUnique({ where: { id } });
  if (!session) {
    const f = fail(ApiCode.NOT_FOUND, "Session not found");
    return apiJson(f.body, f.status);
  }

  const [messages, runs] = await Promise.all([
    prisma.message.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: "asc" },
    }),
    prisma.run.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: "asc" },
      include: { AgentEvent: { orderBy: { seq: "asc" } } }, // 加载 events
    }),
  ]);

  return apiJson(
    ok<SessionDetailData>({
      session: toSessionDTO(session),
      messages: messages.map(toMessageDTO),
      runs: runs.map((run) => ({
        ...toRunDTO(run),
        events: run.AgentEvent.map(toAgentEventDTO), // 包含 events
      })),
    }),
  );
}

/**
 * PATCH /api/sessions/:id — 更新 session title。
 *
 * 当前 GET /api/sessions/:id 也未校验 invite code（历史原因），PATCH 暂保持同样行为：
 * 任何拿到 session id 的人都能改 title。若后续要收紧，需要给 GET 也加校验并做迁移。
 *
 * 校验：title 必须是非空字符串，trim 后写入；超过 100 字符按 POST 创建会话的约定截断。
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    const f = fail(ApiCode.BAD_REQUEST, "invalid JSON");
    return apiJson(f.body, f.status);
  }

  const title = (body as { title?: unknown })?.title;
  if (typeof title !== "string" || !title.trim()) {
    const f = fail(ApiCode.BAD_REQUEST, "title is required");
    return apiJson(f.body, f.status);
  }
  const trimmed = title.trim().slice(0, 100);

  const existing = await prisma.session.findUnique({ where: { id } });
  if (!existing) {
    const f = fail(ApiCode.NOT_FOUND, "Session not found");
    return apiJson(f.body, f.status);
  }

  const updated = await prisma.session.update({
    where: { id },
    data: { title: trimmed },
  });

  return apiJson(ok<{ session: SessionDTO }>({ session: toSessionDTO(updated) }));
}
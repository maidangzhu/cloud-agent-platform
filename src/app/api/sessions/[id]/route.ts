import { prisma } from "@/server/db/client";
import { toMessageDTO, toRunDTO, toSessionDTO } from "@/server/runs/run-service";
import { ApiCode, apiJson, fail, ok } from "@/lib/api-contract";
import type { SessionDetailData } from "@/lib/api-contract";

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
    }),
  ]);

  return apiJson(
    ok<SessionDetailData>({
      session: toSessionDTO(session),
      messages: messages.map(toMessageDTO),
      runs: runs.map(toRunDTO),
    }),
  );
}

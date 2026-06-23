import { prisma } from "@/server/db/client";
import { toMessageDTO, toRunDTO, toSessionDTO, toAgentEventDTO } from "@/server/runs/run-service";
import { ApiCode, apiJson, fail, ok } from "@/lib/api-contract";
import type { SessionDetailData } from "@/lib/api-contract";
import type { AgentEvent, Run } from "@prisma/client";

type RunWithEvents = Run & { events: AgentEvent[] };

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

  const [messages, runs]: [Awaited<ReturnType<typeof prisma.message.findMany>>, RunWithEvents[]] = await Promise.all([
    prisma.message.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: "asc" },
    }),
    prisma.run.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: "asc" },
      include: { events: { orderBy: { seq: "asc" } } }, // 加载 events
    }),
  ]);

  return apiJson(
    ok<SessionDetailData>({
      session: toSessionDTO(session),
      messages: messages.map(toMessageDTO),
      runs: runs.map((run) => ({
        ...toRunDTO(run),
        events: run.events.map(toAgentEventDTO), // 包含 events
      })),
    }),
  );
}

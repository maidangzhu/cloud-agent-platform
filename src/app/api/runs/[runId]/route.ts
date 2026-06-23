import { prisma } from "@/server/db/client";
import {
  toAgentEventDTO,
  toArtifactDTO,
  toRunDTO,
  toToolCallDTO,
} from "@/server/runs/run-service";
import { ApiCode, apiJson, fail, ok } from "@/lib/api-contract";
import type { RunDetailData } from "@/lib/api-contract";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;

  const run = await prisma.run.findUnique({ where: { id: runId } });
  if (!run) {
    const f = fail(ApiCode.NOT_FOUND, "Run not found");
    return apiJson(f.body, f.status);
  }

  const [events, toolCalls, artifacts] = await Promise.all([
    prisma.agentEvent.findMany({ where: { runId }, orderBy: { seq: "asc" } }),
    prisma.toolCall.findMany({ where: { runId }, orderBy: { eventSeq: "asc" } }),
    prisma.artifact.findMany({ where: { runId }, orderBy: { createdAt: "asc" } }),
  ]);

  return apiJson(
    ok<RunDetailData>({
      run: toRunDTO(run),
      events: events.map(toAgentEventDTO),
      toolCalls: toolCalls.map(toToolCallDTO),
      artifacts: artifacts.map(toArtifactDTO),
    }),
  );
}

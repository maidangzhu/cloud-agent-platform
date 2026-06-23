import { prisma } from "@/server/db/client";
import { toRunDTO } from "@/server/runs/run-service";
import { isTerminalRunStatus } from "@/server/runs/run-status";
import { ApiCode, apiJson, fail, ok } from "@/lib/api-contract";
import type { RunStatus } from "@/server/runs/run-status";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;

  const run = await prisma.run.findUnique({ where: { id: runId } });
  if (!run) {
    const f = fail(ApiCode.NOT_FOUND, "Run not found");
    return apiJson(f.body, f.status);
  }

  if (isTerminalRunStatus(run.status as RunStatus)) {
    const f = fail(ApiCode.RUN_NOT_CANCELABLE, "Run 已终态，无法取消");
    return apiJson(f.body, f.status);
  }

  const updated = await prisma.run.update({
    where: { id: runId },
    data: { status: "cancel_requested" },
  });

  return apiJson(ok({ run: toRunDTO(updated) }));
}

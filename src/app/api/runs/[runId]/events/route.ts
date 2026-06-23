export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { prisma } from "@/server/db/client";
import { toAgentEventDTO, toRunDTO } from "@/server/runs/run-service";
import { isTerminalRunStatus } from "@/server/runs/run-status";
import { ApiCode, apiJson, fail } from "@/lib/api-contract";
import type { RunStatus } from "@/server/runs/run-status";

const POLL_MS = 1_000;
const PING_EVERY = 15; // 每 15 次 poll 发一次 ping

function sseFrame(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  return streamRunEvents(runId);
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  return streamRunEvents(runId);
}

async function streamRunEvents(runId: string) {
  const run = await prisma.run.findUnique({ where: { id: runId } });
  if (!run) {
    const f = fail(ApiCode.NOT_FOUND, "Run not found");
    return apiJson(f.body, f.status);
  }

  const stream = new ReadableStream({
    async start(controller) {
      // 1. snapshot：已落事件补给客户端
      const existingEvents = await prisma.agentEvent.findMany({
        where: { runId },
        orderBy: { seq: "asc" },
      });
      controller.enqueue(
        sseFrame("snapshot", {
          run: toRunDTO(run),
          events: existingEvents.map(toAgentEventDTO),
        }),
      );

      // 2. 已是终态 → 直接 done
      if (isTerminalRunStatus(run.status as RunStatus)) {
        controller.enqueue(sseFrame("done", {}));
        controller.close();
        return;
      }

      // 3. 轮询新事件
      let lastSeq = existingEvents.at(-1)?.seq ?? -1;
      let polls = 0;

      const poll = async () => {
        try {
          const currentRun = await prisma.run.findUnique({ where: { id: runId } });
          if (!currentRun) { controller.close(); return; }

          // 推送新事件
          const newEvents = await prisma.agentEvent.findMany({
            where: { runId, seq: { gt: lastSeq } },
            orderBy: { seq: "asc" },
          });
          for (const ev of newEvents) {
            controller.enqueue(sseFrame(ev.type, toAgentEventDTO(ev)));
            lastSeq = ev.seq;
          }

          // 心跳 ping
          if (++polls % PING_EVERY === 0) {
            controller.enqueue(sseFrame("ping", {}));
          }

          // 终态 → done + 关闭
          if (isTerminalRunStatus(currentRun.status as RunStatus)) {
            controller.enqueue(sseFrame("done", {}));
            controller.close();
            return;
          }

          setTimeout(poll, POLL_MS);
        } catch (err) {
          // 只在未关闭时才关闭 controller
          try {
            controller.close();
          } catch {
            // controller 已经关闭，忽略
          }
        }
      };

      setTimeout(poll, POLL_MS);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

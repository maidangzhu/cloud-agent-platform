// transitionRun 原子 UPDATE 封装（Step 6.2，ADR-0018）。
//
// 所有 AgentRun 状态变更（sweep job 判定过期、cancel 端点、ingest 终态
// 事件处理、runner 上报 completed/failed 等）必须唯一走这个函数，不允许
// 任何调用点自己写"先 findUnique 查状态、再 update"的两步式判断——那样
// 会在两次独立往返之间留出竞态窗口（见 ADR-0018 反模式示例）。
//
// 条件 UPDATE：WHERE id = $runId AND status = ANY($fromStatuses)，用受
// 影响行数判断转移是否生效。0 行不是错误，是"状态已被别的调用改走"的
// 正常 no-op 结果——调用方不需要重试，也不需要抛错。

import { prisma } from "@cap/db";
import { isTerminalStatus, type RunStatus } from "./transitions.js";

export type TransitionRunResult = { applied: boolean };

export async function transitionRun(
  runId: string,
  toStatus: RunStatus,
  fromStatuses: readonly RunStatus[],
  patch: { error?: string | null } = {},
): Promise<TransitionRunResult> {
  const now = new Date();
  const result = await prisma.agentRun.updateMany({
    where: { id: runId, status: { in: fromStatuses as RunStatus[] } },
    data: {
      status: toStatus,
      updatedAt: now,
      ...patch,
      ...(isTerminalStatus(toStatus) ? { completedAt: now } : {}),
    },
  });

  return { applied: result.count > 0 };
}

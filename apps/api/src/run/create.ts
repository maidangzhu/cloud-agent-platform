// Run 创建（Step 6.3，见 docs/api-contract.md §5.4、ADR-0018/ADR-0019）。
//
// 两条规则要同时满足：
//
// 1. "thread/workspace 必须 active + 属于当前用户"和"创建 run"不能是
//    两次独立请求之间留窗口的操作（ADR-0018）。用 insert-select：一条
//    语句里 JOIN thread 和 workspace，同时完成归属校验 + 双重 active
//    检查 + 写入，0 行代表三种情况之一（thread 不存在/不属于当前用户/
//    thread 或 workspace 已归档），路由层统一按 404 处理，不区分（同
//    Thread 创建的约定）。
// 2. 如果该 thread 上存在一个 waiting_for_input 的旧 run，先把它原子转为
//    completed，再创建新 run（ADR-0019 的"不做 resume，走新 run"模型）。
//    这一步的"先查找是哪个 run"不是竞态点——真正的状态变更走
//    transitionRun，即使查找和转移之间状态被别的调用抢先改变，
//    transitionRun 内置的 fromStatuses 条件也会让它安全地变成 no-op。

import { randomUUID } from "node:crypto";
import { prisma } from "@cap/db";
import { transitionRun } from "./transition-run.js";

export type CreateRunIfActiveResult =
  | { created: true; runId: string }
  | { created: false };

export async function createRunIfThreadActive(
  threadId: string,
  prompt: string,
  userId: string,
): Promise<CreateRunIfActiveResult> {
  // ADR-0019 收尾：新建 run 之前，先把该 thread 上任何遗留的
  // waiting_for_input run 原子转为 completed。这一步和下面的 insert-select
  // 是顺序的两个独立原子操作，不是同一条语句——两者各自都是原子的，合起来
  // 满足"旧 run 收尾"+"新 run 创建"整体语义，不需要用事务包裹（新 run
  // 创建失败不会导致旧 run 被错误收尾成一个"没有下家"的孤立状态，因为旧
  // run 转 completed 本身就是它自己合法的终态转移，不依赖新 run 是否创建
  // 成功）。
  const staleWaiting = await prisma.agentRun.findFirst({
    where: { threadId, status: "waiting_for_input" },
  });
  if (staleWaiting) {
    await transitionRun(staleWaiting.id, "completed", ["waiting_for_input"]);
  }

  const runId = randomUUID();
  const messageId = randomUUID();

  const rowCount = await prisma.$transaction(async (tx) => {
    const inserted = await tx.$executeRaw`
      INSERT INTO "AgentRun" (id, "workspaceId", "threadId", "userId", prompt, status, "createdAt", "updatedAt")
      SELECT ${runId}, w.id, t.id, ${userId}, ${prompt}, 'created', now(), now()
      FROM "Thread" t
      JOIN "Workspace" w ON w.id = t."workspaceId"
      WHERE t.id = ${threadId} AND t.status = 'active' AND w.status = 'active' AND w."ownerUserId" = ${userId}
    `;

    if (inserted === 0) {
      return 0;
    }

    const run = await tx.agentRun.findUniqueOrThrow({ where: { id: runId } });
    await tx.threadMessage.create({
      data: {
        id: messageId,
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        runId: run.id,
        role: "user",
        content: prompt,
      },
    });
    return inserted;
  });

  if (rowCount === 0) {
    return { created: false };
  }
  return { created: true, runId };
}

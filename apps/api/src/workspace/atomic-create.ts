// Workspace 归档的原子拒绝（Step 4.2，ADR-0018）。
//
// "检查 workspace 是否 active"和"创建子资源（thread/run）"不能是两次
// 独立请求之间留窗口的操作（check-then-act）。用 insert-select：
// INSERT ... SELECT ... FROM Workspace WHERE status='active'，让数据库
// 在一条语句里同时完成条件检查和写入，插入 0 行即代表 workspace 不是
// active（已被并发的归档请求抢先），不存在"先查到 active、再创建成功
// 但 workspace 实际已被归档"的中间状态。
//
// 这是一个可复用的原子模式：本 Step 先用 Thread 验证（thread/run 表都
// 还没进入正式 CRUD 阶段，Thread 是 Step 4.2 为验证而提前建的最小表，
// 见 packages/db/prisma/schema.prisma 注释），Group 5/6 的 Thread/Run
// 完整 CRUD 落地时复用同一模式。

import { randomUUID } from "node:crypto";
import { prisma } from "@cap/db";

export type CreateThreadIfWorkspaceActiveResult =
  | { created: true; threadId: string }
  | { created: false };

export async function createThreadIfWorkspaceActive(
  workspaceId: string,
  title: string,
): Promise<CreateThreadIfWorkspaceActiveResult> {
  const threadId = randomUUID();

  // Prisma 的 query builder 不支持"INSERT ... SELECT"这种形状，用
  // $executeRaw 直写 SQL——这是 ADR-0018 原子性要求下的合理例外，不是
  // 绕过 ORM 的随意选择。
  const rowCount = await prisma.$executeRaw`
    INSERT INTO "Thread" (id, "workspaceId", title, status, "createdAt", "updatedAt")
    SELECT ${threadId}, w.id, ${title}, 'active', now(), now()
    FROM "Workspace" w
    WHERE w.id = ${workspaceId} AND w.status = 'active'
  `;

  if (rowCount === 0) {
    return { created: false };
  }
  return { created: true, threadId };
}

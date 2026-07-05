// Thread 创建的原子拒绝（Step 4.2 提前搭好骨架，Step 5.1 补齐真实字段/
// 归属校验，ADR-0018）。
//
// "检查 workspace 是否 active + 属于当前用户"和"创建 thread"不能是两次
// 独立请求之间留窗口的操作（check-then-act）。用 insert-select：
// INSERT ... SELECT ... FROM Workspace WHERE status='active' AND
// ownerUserId=$ownerUserId，让数据库在一条语句里同时完成鉴权、状态检查
// 和写入——插入 0 行代表"workspace 不存在/不是当前用户的/已被归档"三种
// 情况之一（路由层统一按 404 处理，不区分，避免探测，同 workspace 路由
// 的约定），不存在"先查到 active、再创建成功但 workspace 实际已被归档"
// 的中间状态。

import { randomUUID } from "node:crypto";
import { prisma } from "@cap/db";

export type CreateThreadIfWorkspaceActiveResult =
  | { created: true; threadId: string }
  | { created: false };

export async function createThreadIfWorkspaceActive(
  workspaceId: string,
  title: string,
  ownerUserId: string,
): Promise<CreateThreadIfWorkspaceActiveResult> {
  const threadId = randomUUID();

  // Prisma 的 query builder 不支持"INSERT ... SELECT"这种形状，用
  // $executeRaw 直写 SQL——这是 ADR-0018 原子性要求下的合理例外，不是
  // 绕过 ORM 的随意选择。
  const rowCount = await prisma.$executeRaw`
    INSERT INTO "Thread" (id, "workspaceId", title, status, "createdAt", "updatedAt")
    SELECT ${threadId}, w.id, ${title}, 'active', now(), now()
    FROM "Workspace" w
    WHERE w.id = ${workspaceId} AND w.status = 'active' AND w."ownerUserId" = ${ownerUserId}
  `;

  if (rowCount === 0) {
    return { created: false };
  }
  return { created: true, threadId };
}

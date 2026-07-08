import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@cap/db";
import { createThreadIfWorkspaceActive } from "./create.js";

// 连真实 Neon Postgres，不 mock。对应 docs/testing-strategy.md §4.3
// route 13、Step 4.2 integration 16-17（迁移到 thread/ 目录，Step 5.1
// 补齐 ownerUserId 归属校验）。
const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)(
  "Thread 创建的原子拒绝（真实 Neon，ADR-0018，见 Step 4.2/5.1）",
  () => {
    const testOwnerId = `it-atomic-${Date.now()}`;
    const otherOwnerId = `it-atomic-other-${Date.now()}`;

    afterAll(async () => {
      const workspaces = await prisma.workspace.findMany({
        where: { ownerUserId: { in: [testOwnerId, otherOwnerId] } },
      });
      const ids = workspaces.map((w) => w.id);
      if (ids.length > 0) {
        await prisma.thread.deleteMany({
          where: { workspaceId: { in: ids } },
        });
        await prisma.workspace.deleteMany({ where: { id: { in: ids } } });
      }
      await prisma.$disconnect();
    });

    it("active workspace 下创建 thread 成功", async () => {
      const ws = await prisma.workspace.create({
        data: {
          id: randomUUID(),
          ownerUserId: testOwnerId,
          title: "IT-Atomic-Active",
        },
      });

      const result = await createThreadIfWorkspaceActive(
        ws.id,
        "hello",
        testOwnerId,
      );

      expect(result.created).toBe(true);
    });

    it(
      "archived workspace rejects run creation via insert-select" +
        "（0 行，不是先查后拒）",
      async () => {
        const ws = await prisma.workspace.create({
          data: {
            id: randomUUID(),
            ownerUserId: testOwnerId,
            title: "IT-Atomic-Archived",
            status: "archived",
            archivedAt: new Date(),
          },
        });

        const result = await createThreadIfWorkspaceActive(
          ws.id,
          "should not exist",
          testOwnerId,
        );

        expect(result.created).toBe(false);

        // 确认没有任何 thread 被创建——insert 语句本身 0 行影响，不是
        // "创建后再回滚"，数据库里应该找不到任何相关记录。
        const threads = await prisma.thread.findMany({
          where: { workspaceId: ws.id },
        });
        expect(threads.length).toBe(0);
      },
    );

    it("cannot create thread inside another user's workspace（0 行）", async () => {
      const ws = await prisma.workspace.create({
        data: {
          id: randomUUID(),
          ownerUserId: testOwnerId,
          title: "IT-Atomic-OwnedByA",
        },
      });

      const result = await createThreadIfWorkspaceActive(
        ws.id,
        "should not exist",
        otherOwnerId,
      );

      expect(result.created).toBe(false);

      const threads = await prisma.thread.findMany({
        where: { workspaceId: ws.id },
      });
      expect(threads.length).toBe(0);
    });

    it(
      "concurrent archive + create-thread race: only one outcome wins, " +
        "no partial state",
      async () => {
        const ws = await prisma.workspace.create({
          data: {
            id: randomUUID(),
            ownerUserId: testOwnerId,
            title: "IT-Atomic-Race",
          },
        });

        // 并发发起：一个归档请求 + 多个创建 thread 请求，模拟真实竞态。
        // 用 Promise.all 让它们几乎同时打到数据库。
        const [archiveResult, ...createResults] = await Promise.all([
          prisma.workspace.updateMany({
            where: { id: ws.id, status: "active" },
            data: { status: "archived", archivedAt: new Date() },
          }),
          createThreadIfWorkspaceActive(ws.id, "race-1", testOwnerId),
          createThreadIfWorkspaceActive(ws.id, "race-2", testOwnerId),
          createThreadIfWorkspaceActive(ws.id, "race-3", testOwnerId),
        ]);

        // 归档请求本身也是条件原子 UPDATE（Step 4.1 已用的模式），必然
        // 恰好成功一次（这里就这一次归档请求，count 应为 1）。
        expect(archiveResult.count).toBe(1);

        // 每个并发的创建请求，结果只能是"成功"或"失败"，不存在第三种
        // 中间状态（如创建了一半、或抛出未处理异常）。
        for (const result of createResults) {
          expect(typeof result.created).toBe("boolean");
        }

        // 核心断言：最终数据库里的 thread 数量，必须和"created: true"
        // 的结果数量完全一致——不多不少，没有幽灵记录，也没有丢失记录。
        const succeededCount = createResults.filter((r) => r.created).length;
        const actualThreads = await prisma.thread.findMany({
          where: { workspaceId: ws.id },
        });
        expect(actualThreads.length).toBe(succeededCount);

        // 最终 workspace 状态必须是 archived（不会因为并发创建请求而
        // 被覆盖回 active，两者操作的是不同列/不同判断条件）。
        const finalWs = await prisma.workspace.findUnique({
          where: { id: ws.id },
        });
        expect(finalWs?.status).toBe("archived");
      },
    );
  },
);

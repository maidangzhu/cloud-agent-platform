import { describe, expect, it } from "vitest";
import { prisma } from "./client";

// 集成测试：验证 packages/db 的 Prisma client 能连上真实数据库并执行查询。
// 复用根目录同款约定（DATABASE_URL 缺失时整组 skip）。运行：pnpm test:integration
describe.skipIf(!process.env.DATABASE_URL)(
  "packages/db Prisma client（真实数据库）",
  () => {
    it("能连接并执行一次简单查询", async () => {
      const result = await prisma.$queryRaw<{ ok: number }[]>`SELECT 1 as ok`;
      expect(result[0]?.ok).toBe(1);
    });
  },
);

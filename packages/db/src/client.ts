// Prisma client 单例（packages/db 版本，见 docs/implementation-roadmap.md
// Group 2 Step 2.3）。与根目录 src/server/db/client.ts 同构，是同一份逻辑
// 的 monorepo package 化版本，供 apps/api 使用。
// Prisma 7 运行时必须通过 driver adapter 连接；本项目 DB 是 Neon Postgres，
// 用 @prisma/adapter-pg（node-postgres / TCP，兼容 Neon pooler 端点）。
// 连接串来自 DATABASE_URL。

import { PrismaPg } from "@prisma/adapter-pg";
// 从独立生成路径导入（见 prisma/schema.prisma 的 generator.output 注释），
// 不用共享的 "@prisma/client"——根目录 schema 和这里共享同一物理生成目录
// 会互相覆盖对方产物，已实测踩坑。
import { PrismaClient } from "../node_modules/.prisma-cap-db/client/index.js";

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set — cannot create Prisma client (need a Neon/Postgres connection string).",
    );
  }
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

// 复用单例，避免开发模式热重载反复建连接池。
const globalForPrisma = globalThis as unknown as {
  __cap_db_prisma__?: PrismaClient;
};

export const prisma: PrismaClient =
  globalForPrisma.__cap_db_prisma__ ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__cap_db_prisma__ = prisma;
}

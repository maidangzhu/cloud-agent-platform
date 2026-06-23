// Prisma client 单例。
// Prisma 7 运行时必须通过 driver adapter 连接；本项目 DB 是 Neon Postgres，
// 用 @prisma/adapter-pg（node-postgres / TCP，兼容 Neon pooler 端点）。
// 连接串来自 DATABASE_URL（见 .env / .env.example）。
//
// 单元测试零外部依赖、不导入本文件；只有集成测试与运行时 app 用它。

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

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

// 复用单例，避免 Next.js dev 热重载反复建连接池。
const globalForPrisma = globalThis as unknown as {
  __prisma__?: PrismaClient;
};

export const prisma: PrismaClient =
  globalForPrisma.__prisma__ ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__prisma__ = prisma;
}

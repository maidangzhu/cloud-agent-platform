import path from "node:path";
import { defineConfig } from "prisma/config";

// Prisma 7 不再从 schema 读取 datasource url，也不自动加载 .env。
// 这里用 Node 内置 loadEnvFile 加载本地 .env（缺失时忽略），供 CLI 命令
//（prisma migrate / db push）使用。运行时的 PrismaClient 走 driver adapter，
// 不依赖此文件。
try {
  process.loadEnvFile(path.join(process.cwd(), ".env"));
} catch {
  // 没有 .env 时忽略（CI / 生产用真实环境变量）
}

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  datasource: {
    // 用 ?? "" 兜底：generate/build/test 不连库，缺 DATABASE_URL 也不报错；
    // migrate / db push 时真实值已由 .env 或环境注入。
    url: process.env.DATABASE_URL ?? "",
  },
});


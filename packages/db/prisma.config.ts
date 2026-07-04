import path from "node:path";
import { defineConfig } from "prisma/config";

// 与根目录 prisma.config.ts 同构（Step 2.3：packages/db 副本，见
// docs/implementation-roadmap.md Group 2 Step 2.3）。Prisma 7 不再从
// schema 读取 datasource url，也不自动加载 .env。这里从 monorepo 根目录
// 加载 .env（packages/db 本身不单独放 .env），供 CLI 命令使用。
// 运行时的 PrismaClient 走 driver adapter，不依赖此文件。
try {
  process.loadEnvFile(path.join(process.cwd(), "..", "..", ".env"));
} catch {
  // 没有 .env 时忽略（CI / 生产用真实环境变量）
}

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
});

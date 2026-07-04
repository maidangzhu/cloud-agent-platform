import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

// 单元测试启动前从 monorepo 根目录加载 .env（与 packages/db/tests/load-env.ts
// 同构）。这里只是让 auth.ts 在模块加载阶段构造 PrismaClient 时能拿到
// DATABASE_URL 字符串，不会真的连接数据库（PrismaClient 构造不建连接，
// 首次查询才建连接）——app.test.ts 仍然是零网络依赖的单元测试。
const monorepoRoot = path.join(process.cwd(), "..", "..");

for (const file of [".env", ".env.local"]) {
  try {
    const parsed = parseEnv(
      fs.readFileSync(path.join(monorepoRoot, file), "utf8"),
    );
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value !== "") {
        process.env[key] = value;
      }
    }
  } catch {
    // 文件不存在则忽略
  }
}

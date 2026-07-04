import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

// 集成测试启动前从 monorepo 根目录加载 .env / .env.local（同根目录
// tests/load-env.ts 的加载顺序和跳过空值规则），让真实 DATABASE_URL 可见。
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
    // 文件不存在则忽略——缺 env 的集成测试会自动跳过（describe.skipIf）。
  }
}

import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { ProxyAgent, setGlobalDispatcher } from "undici";

// 集成测试启动前加载本地环境变量，让真实 DATABASE_URL / VERCEL_TOKEN /
// VERCEL_OIDC_TOKEN 等可见。单元测试不走这个 setup，保持零外部依赖。
//
// 用 parseEnv + 手动赋值（而非 process.loadEnvFile，后者不覆盖已存在 key）：
//   - 加载顺序 .env → .env.local，后者覆盖前者（与 Next.js 一致）；
//   - 跳过空字符串值，避免占位 `FOO=""` 覆盖另一文件里的真实值。
for (const file of [".env", ".env.local"]) {
  try {
    const parsed = parseEnv(
      fs.readFileSync(path.join(process.cwd(), file), "utf8"),
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

// Node 原生 fetch（undici）默认不认 HTTPS_PROXY。某些网络下 vercel.com 被墙，
// 需经本地代理（如 Clash 127.0.0.1:7890）才能访问 Vercel Sandbox API。
// 仅当显式设置 HTTPS_PROXY 时启用；生产/CI/全局代理(TUN) 不设此变量则无副作用。
const proxy =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.ALL_PROXY ||
  process.env.all_proxy;
if (proxy) {
  setGlobalDispatcher(new ProxyAgent(proxy));
}

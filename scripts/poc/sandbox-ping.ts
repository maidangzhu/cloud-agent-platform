// PoC 脚本：验证 v2 分支下 Vercel Sandbox 封装仍然可用。
// 不是正式功能代码，跑完确认通了就可以删除或忽略。
//
// 用法：pnpm tsx scripts/poc/sandbox-ping.ts
// 依赖：.env 或 .env.local 里的 VERCEL_TOKEN（或 VERCEL_OIDC_TOKEN）

import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

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
    // 文件不存在则忽略
  }
}

async function main() {
  const { resolveVercelCredentials } = await import(
    "../../apps/api/src/sandbox/vercel-credentials"
  );
  const { getOrCreateSandbox } = await import(
    "../../apps/api/src/sandbox/factory"
  );

  const creds = resolveVercelCredentials();
  if (!creds) {
    console.error(
      "缺少 Vercel 凭证。请设置 VERCEL_TOKEN，或 VERCEL_OIDC_TOKEN（+ 可选 VERCEL_TEAM_ID/VERCEL_PROJECT_ID）。",
    );
    process.exit(1);
  }

  console.log("创建/复用沙箱...");
  const sessionId = `poc-${Date.now()}`;
  const { sandbox } = await getOrCreateSandbox({ sessionId });

  try {
    console.log("✅ 沙箱已就绪");

    await sandbox.writeFile("poc-notes/hello.txt", "hello-sandbox");
    console.log("✅ writeFile OK");

    const content = await sandbox.readFile("poc-notes/hello.txt");
    if (content !== "hello-sandbox") {
      throw new Error(`readFile 往返值不匹配，收到: ${content}`);
    }
    console.log("✅ readFile 往返 OK");

    const entries = await sandbox.readdir("poc-notes");
    console.log(`✅ readdir OK，看到 ${entries.length} 个条目`);

    console.log("\n全部通过：Vercel Sandbox 在 v2 分支下可用。");
  } finally {
    await sandbox.stop();
    console.log("沙箱已停止。");
  }
}

main().catch((err) => {
  console.error("❌ 失败:", err);
  process.exit(1);
});

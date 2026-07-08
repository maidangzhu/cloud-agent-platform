import path from "node:path";

// 本地 dev 入口：用 @hono/node-server 跑一个 Node HTTP server。
// 部署到 Vercel 时用 src/server.ts 的 default export；这个文件只服务本地开发。
//
// 加载 monorepo 根目录的 .env 必须在 import ./app 之前完成——ES module 的
// import 会被提升到文件顶部先求值，如果 .env 加载和 import 写在同一个文件里，
// import 触发的连锁加载（app → auth → packages/db）会在 loadEnvFile 真正
// 执行之前就跑完，导致 DATABASE_URL 还没写入 process.env（已实测踩坑）。
// 用动态 import 延后加载确保顺序；包成 main() 避免顶层 await（tsx 按 cjs
// 转译时不支持顶层 await，也已实测踩坑）。
try {
  process.loadEnvFile(path.join(process.cwd(), "..", "..", ".env"));
} catch {
  // 没有 .env 时忽略
}

async function main() {
  const { serve } = await import("@hono/node-server");
  const { createApp } = await import("./app.js");

  const port = Number(process.env.PORT) || 8787;

  serve({
    fetch: createApp().fetch,
    port,
  });

  console.log(`@cap/api listening on http://localhost:${port}`);
}

main();

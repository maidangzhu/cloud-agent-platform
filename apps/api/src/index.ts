import { serve } from "@hono/node-server";
import { createApp } from "./app";

// 本地 dev 入口：用 @hono/node-server 跑一个 Node HTTP server。
// 部署到 Vercel 时用 @hono/vercel adapter（见 Step 2.4 之后的部署阶段），
// 这个文件只服务本地开发，不是生产入口。
const port = Number(process.env.PORT) || 8787;

serve({
  fetch: createApp().fetch,
  port,
});

console.log(`@cap/api listening on http://localhost:${port}`);

import type { NextConfig } from "next";

// 本地开发跨域 cookie 代理（Step 2.4，ADR-0022）：把 /api/health 代理到本地
// Hono（apps/api，默认端口 8787），让浏览器视角只有一个 origin，避免本地
// apps/web(:3000) 和 apps/api(:8787) 之间的跨域 cookie 问题。
// 只代理 /api/health 这一条具体路径做验证——不能写通配的 /api/*，因为
// Next.js 的 rewrite 在文件系统路由之后才生效，通配会和 src/app/api/* 下
// 已存在的 v1 路由（invite/sessions/runs 等）冲突。等 Group 3 真正把
// v1 代码迁移进 apps/web 后，这条规则会替换成指向 apps/api 的完整代理。
const API_PROXY_TARGET = process.env.API_PROXY_TARGET || "http://localhost:8787";

const nextConfig: NextConfig = {
  // 空的 turbopack 配置，明确使用 Turbopack
  turbopack: {},

  // 标记为外部依赖，避免 Vercel 打包时的动态 require 错误
  serverExternalPackages: ["@earendil-works/pi-ai"],

  async rewrites() {
    return [
      {
        source: "/api/health",
        destination: `${API_PROXY_TARGET}/health`,
      },
    ];
  },
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 空的 turbopack 配置，明确使用 Turbopack
  turbopack: {},

  // 标记为外部依赖，避免 Vercel 打包时的动态 require 错误
  serverExternalPackages: ["@earendil-works/pi-ai"],
};

export default nextConfig;

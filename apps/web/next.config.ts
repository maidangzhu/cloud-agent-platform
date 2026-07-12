import type { NextConfig } from "next";

const apiProxyTarget =
  process.env.API_PROXY_TARGET?.replace(/\/$/, "") || "http://localhost:8787";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  turbopack: {},
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/api/:path*",
          destination: `${apiProxyTarget}/api/:path*`,
        },
      ],
    };
  },
};

export default nextConfig;

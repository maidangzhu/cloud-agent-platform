import { defineConfig } from "vitest/config";

// 集成测试配置：连真实 Neon Postgres（不 mock），仅匹配 *.integration.test.ts。
// 与 packages/db/vitest.integration.config.ts、根目录 vitest.integration.config.ts
// 同构。真实数据库连接需要网络往返，放宽超时。
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.integration.test.ts"],
    setupFiles: ["./tests/load-env.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});

import { defineConfig } from "vitest/config";

// 集成测试配置：连真实 Neon Postgres，仅匹配 *.integration.test.ts。
// 与根目录 vitest.integration.config.ts 同构。
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.integration.test.ts"],
    setupFiles: ["./tests/load-env.ts"],
    testTimeout: 30_000,
  },
});

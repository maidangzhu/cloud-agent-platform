import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./tests/load-env.ts"],
    // 集成测试（连真实 Neon）单独走 vitest.integration.config.ts，
    // 默认 test 命令排除，保持零外部依赖前提（与 packages/db 同构）。
    exclude: [
      "**/node_modules/**",
      "**/*.integration.test.ts",
      "**/*.workflow.test.ts",
      "**/*.live.test.ts",
    ],
  },
});

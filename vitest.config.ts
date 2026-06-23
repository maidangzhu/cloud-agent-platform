import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 测试零外部依赖：默认 node 环境，跑服务端纯逻辑 / 集成测试。
// UI 组件测试（阶段 5）如需 jsdom，可在对应文件用 `// @vitest-environment jsdom` 覆盖。
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // 集成测试（连真实 DB / 沙箱）单独走 vitest.integration.config.ts，
    // 默认单元套件必须零外部依赖，故排除。
    exclude: ["**/node_modules/**", "**/*.integration.test.ts"],
  },
});

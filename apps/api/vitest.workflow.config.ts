import { defineConfig } from "vitest/config";

// Workflow tests：不开浏览器，但走完整产品路径。
// 允许真实 Neon / Redis / Vercel Sandbox；可以使用 deterministic LLM/Search
// provider 稳定断言协议。测试文件命名：*.workflow.test.ts。
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.workflow.test.ts"],
    setupFiles: ["./tests/load-env.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});

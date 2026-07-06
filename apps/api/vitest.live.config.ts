import { defineConfig } from "vitest/config";

// Live / expensive tests：真实 deployed API、真实 provider、长上下文、
// fallback/retry/timeout 等高成本边界。测试文件命名：*.live.test.ts。
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.live.test.ts"],
    setupFiles: ["./tests/load-env.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});

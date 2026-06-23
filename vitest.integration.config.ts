import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 集成测试配置：连真实 DB / 沙箱，仅匹配 *.integration.test.ts。
// 通过 setupFiles 加载 .env；缺对应 env 时各测试文件用 describe.skipIf 自动跳过。
// 与单元测试（vitest.config.ts，零外部依赖）分开，互不影响。
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.integration.test.ts", "tests/**/*.integration.test.ts"],
    setupFiles: ["./tests/load-env.ts"],
    // 集成测试连真实基础设施，放宽超时（沙箱冷启动可能数秒~数十秒）。
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // 串行，避免并发写同一张表互相干扰。
    fileParallelism: false,
  },
});

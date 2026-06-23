import { describe, expect, it } from "vitest";

// Smoke test：确认 vitest 配置可跑。后续阶段会替换为真实的纯逻辑/集成测试。
describe("vitest setup", () => {
  it("runs the suite", () => {
    expect(1 + 1).toBe(2);
  });
});

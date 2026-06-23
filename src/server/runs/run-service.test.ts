import { describe, expect, it } from "vitest";
import { derivedUiState } from "./run-service";

const now = Date.now();
const fresh = new Date(now - 10_000);       // 10s ago
const stale = new Date(now - 70_000);       // 70s ago
const dead = new Date(now - 130_000);       // 130s ago

describe("derivedUiState — 终态", () => {
  it.each([
    ["completed", "completed"],
    ["failed", "failed"],
    ["timeout", "timeout"],
    ["cancelled", "cancelled"],
    ["cancel_requested", "cancelled"],
    ["interrupted", "interrupted"],
    ["created", "idle"],
  ] as const)("%s → %s", (status, expected) => {
    expect(derivedUiState(status, null)).toBe(expected);
  });
});

describe("derivedUiState — 活跃状态（按心跳新鲜度）", () => {
  it.each(["running", "provisioning_workspace"] as const)("%s + 新鲜心跳 → running", (s) => {
    expect(derivedUiState(s, fresh)).toBe("running");
  });
  it.each(["running", "provisioning_workspace"] as const)("%s + 过期心跳 → possibly_running", (s) => {
    expect(derivedUiState(s, stale)).toBe("possibly_running");
  });
  it.each(["running", "provisioning_workspace"] as const)("%s + 极旧心跳 → interrupted", (s) => {
    expect(derivedUiState(s, dead)).toBe("interrupted");
  });
  it.each(["running", "provisioning_workspace"] as const)("%s + 无心跳 → interrupted", (s) => {
    expect(derivedUiState(s, null)).toBe("interrupted");
  });
});

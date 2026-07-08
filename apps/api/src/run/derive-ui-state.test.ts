import { describe, expect, it } from "vitest";
import { deriveUiState } from "./derive-ui-state.js";
import { TERMINAL_RUN_STATUSES, type RunStatus } from "./transitions.js";

// docs/testing-strategy.md §4.4 unit 8-11
const NOW = new Date("2026-07-04T12:00:00Z");

describe("deriveUiState", () => {
  it("derived UI state maps correctly for each RunStatus，含 waiting_for_input -> waiting_for_input", () => {
    expect(deriveUiState("created", null, NOW)).toBe("idle");
    expect(deriveUiState("cancel_requested", null, NOW)).toBe("cancelling");
    expect(deriveUiState("waiting_for_input", null, NOW)).toBe(
      "waiting_for_input",
    );
    for (const status of TERMINAL_RUN_STATUSES as RunStatus[]) {
      expect(deriveUiState(status, null, NOW)).toBe(status);
    }
  });

  it("derived UI state: stale heartbeat maps running -> possibly_running", () => {
    const staleHeartbeat = new Date(NOW.getTime() - 31_000);
    expect(deriveUiState("running", staleHeartbeat, NOW)).toBe(
      "possibly_running",
    );

    const freshHeartbeat = new Date(NOW.getTime() - 10_000);
    expect(deriveUiState("running", freshHeartbeat, NOW)).toBe("running");
  });

  it("derived UI state: terminal status ignores heartbeat staleness", () => {
    const staleHeartbeat = new Date(NOW.getTime() - 999_999);
    for (const status of TERMINAL_RUN_STATUSES as RunStatus[]) {
      expect(deriveUiState(status, staleHeartbeat, NOW)).toBe(status);
    }
  });

  it("derived UI state: waiting_for_input 不依赖 heartbeat 推导", () => {
    const staleHeartbeat = new Date(NOW.getTime() - 999_999);
    expect(deriveUiState("waiting_for_input", staleHeartbeat, NOW)).toBe(
      "waiting_for_input",
    );
    expect(deriveUiState("waiting_for_input", null, NOW)).toBe(
      "waiting_for_input",
    );
  });

  it("provisioning_sandbox 用 createdAt 兜底新鲜度判断（还没有 heartbeat 时）", () => {
    const recentCreatedAt = new Date(NOW.getTime() - 5_000);
    expect(
      deriveUiState("provisioning_sandbox", null, NOW, recentCreatedAt),
    ).toBe("running");

    const staleCreatedAt = new Date(NOW.getTime() - 60_000);
    expect(
      deriveUiState("provisioning_sandbox", null, NOW, staleCreatedAt),
    ).toBe("possibly_running");
  });
});

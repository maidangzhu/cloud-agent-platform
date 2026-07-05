import { describe, expect, it } from "vitest";
import {
  isLegalTransition,
  isTerminalStatus,
  TERMINAL_RUN_STATUSES,
  type RunStatus,
} from "./transitions";

// docs/testing-strategy.md §4.4 unit 1-7；转移表本身对照
// docs/state-machines.md §1"状态转移"小节。
const LEGAL_PAIRS: Array<[RunStatus, RunStatus]> = [
  ["created", "provisioning_sandbox"],
  ["created", "cancel_requested"],
  ["created", "failed"],
  ["provisioning_sandbox", "running"],
  ["provisioning_sandbox", "cancel_requested"],
  ["provisioning_sandbox", "failed"],
  ["provisioning_sandbox", "timeout"],
  ["running", "cancel_requested"],
  ["running", "completed"],
  ["running", "failed"],
  ["running", "timeout"],
  ["running", "interrupted"],
  ["running", "waiting_for_input"],
  ["waiting_for_input", "cancel_requested"],
  ["waiting_for_input", "completed"],
  ["waiting_for_input", "interrupted"],
  ["cancel_requested", "cancelled"],
  ["cancel_requested", "failed"],
  ["cancel_requested", "timeout"],
];

const ALL_STATUSES: RunStatus[] = [
  "created",
  "provisioning_sandbox",
  "running",
  "waiting_for_input",
  "cancel_requested",
  "completed",
  "failed",
  "timeout",
  "cancelled",
  "interrupted",
];

describe("isLegalTransition", () => {
  it("all legal RunStatus transitions succeed（含 running -> waiting_for_input）", () => {
    for (const [from, to] of LEGAL_PAIRS) {
      expect(isLegalTransition(from, to)).toBe(true);
    }
  });

  it("all illegal RunStatus transitions rejected（如 created -> completed 直跳）", () => {
    const legalSet = new Set(LEGAL_PAIRS.map(([f, t]) => `${f}->${t}`));
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (from === to) continue;
        if (legalSet.has(`${from}->${to}`)) continue;
        expect(isLegalTransition(from, to)).toBe(false);
      }
    }
  });

  it("terminal status rejects any further transition", () => {
    for (const terminal of TERMINAL_RUN_STATUSES) {
      for (const to of ALL_STATUSES) {
        expect(isLegalTransition(terminal, to)).toBe(false);
      }
    }
  });

  it("created/provisioning/running/waiting_for_input 都可以请求 cancel", () => {
    expect(isLegalTransition("created", "cancel_requested")).toBe(true);
    expect(isLegalTransition("provisioning_sandbox", "cancel_requested")).toBe(
      true,
    );
    expect(isLegalTransition("running", "cancel_requested")).toBe(true);
    expect(isLegalTransition("waiting_for_input", "cancel_requested")).toBe(
      true,
    );
  });

  it("timeout 可以收敛 provisioning/running/cancel_requested", () => {
    expect(isLegalTransition("provisioning_sandbox", "timeout")).toBe(true);
    expect(isLegalTransition("running", "timeout")).toBe(true);
    expect(isLegalTransition("cancel_requested", "timeout")).toBe(true);
  });

  it("waiting_for_input -> completed 转移合法（收尾场景，见 ADR-0019）", () => {
    expect(isLegalTransition("waiting_for_input", "completed")).toBe(true);
  });

  it("waiting_for_input -> interrupted 转移合法（sweep 兜底场景）", () => {
    expect(isLegalTransition("waiting_for_input", "interrupted")).toBe(true);
  });
});

describe("isTerminalStatus", () => {
  it("终态集合与 docs/state-machines.md §1 一致", () => {
    for (const status of TERMINAL_RUN_STATUSES) {
      expect(isTerminalStatus(status)).toBe(true);
    }
    expect(isTerminalStatus("running")).toBe(false);
    expect(isTerminalStatus("waiting_for_input")).toBe(false);
  });
});

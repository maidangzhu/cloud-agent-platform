import { describe, expect, it } from "vitest";
import {
  RunStatus as PrismaRunStatus,
  SessionStatus as PrismaSessionStatus,
} from "@prisma/client";
import {
  RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  assertRunTransition,
  canTransitionRun,
  isTerminalRunStatus,
} from "./run-status";
import {
  SESSION_STATUSES,
  assertSessionTransition,
  canTransitionSession,
  isArchivedSession,
} from "../sessions/session-status";

describe("run-status — 与 Prisma schema 同步", () => {
  it("RUN_STATUSES 集合与 Prisma RunStatus 枚举一致", () => {
    expect([...RUN_STATUSES].sort()).toEqual(
      Object.values(PrismaRunStatus).sort(),
    );
  });
});

describe("run-status — 合法转移", () => {
  it("主链路：created → provisioning_workspace → running → completed", () => {
    expect(canTransitionRun("created", "provisioning_workspace")).toBe(true);
    expect(canTransitionRun("provisioning_workspace", "running")).toBe(true);
    expect(canTransitionRun("running", "completed")).toBe(true);
  });

  it("running 可分支到 failed / timeout / cancel_requested / interrupted", () => {
    for (const to of [
      "failed",
      "timeout",
      "cancel_requested",
      "interrupted",
    ] as const) {
      expect(canTransitionRun("running", to)).toBe(true);
    }
  });

  it("cancel_requested → cancelled", () => {
    expect(canTransitionRun("cancel_requested", "cancelled")).toBe(true);
  });
});

describe("run-status — 非法转移", () => {
  it("不能跳过 provisioning 直接 created → running", () => {
    expect(canTransitionRun("created", "running")).toBe(false);
  });

  it("不能从 completed 倒流回 running", () => {
    expect(canTransitionRun("completed", "running")).toBe(false);
  });

  it("不能 running → created 倒流", () => {
    expect(canTransitionRun("running", "created")).toBe(false);
  });
});

describe("run-status — 终态守卫", () => {
  it("终态集合 = completed/failed/timeout/cancelled/interrupted", () => {
    expect([...TERMINAL_RUN_STATUSES].sort()).toEqual(
      ["cancelled", "completed", "failed", "interrupted", "timeout"].sort(),
    );
  });

  it("所有终态都无任何后继（不可再转移）", () => {
    for (const from of TERMINAL_RUN_STATUSES) {
      expect(isTerminalRunStatus(from)).toBe(true);
      for (const to of RUN_STATUSES) {
        expect(canTransitionRun(from, to)).toBe(false);
      }
    }
  });

  it("非终态不被误判为终态", () => {
    for (const s of [
      "created",
      "provisioning_workspace",
      "running",
      "cancel_requested",
    ] as const) {
      expect(isTerminalRunStatus(s)).toBe(false);
    }
  });
});

describe("run-status — assert 抛错", () => {
  it("合法转移不抛", () => {
    expect(() => assertRunTransition("running", "completed")).not.toThrow();
  });

  it("非法转移抛错且信息含 from/to", () => {
    expect(() => assertRunTransition("completed", "running")).toThrow(
      /completed.*running/,
    );
  });
});

describe("session-status", () => {
  it("SESSION_STATUSES 与 Prisma SessionStatus 枚举一致", () => {
    expect([...SESSION_STATUSES].sort()).toEqual(
      Object.values(PrismaSessionStatus).sort(),
    );
  });

  it("active → archived 合法；archived 为终态", () => {
    expect(canTransitionSession("active", "archived")).toBe(true);
    expect(canTransitionSession("archived", "active")).toBe(false);
    expect(isArchivedSession("archived")).toBe(true);
    expect(isArchivedSession("active")).toBe(false);
  });

  it("非法转移 assert 抛错", () => {
    expect(() => assertSessionTransition("archived", "active")).toThrow();
    expect(() => assertSessionTransition("active", "archived")).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import {
  AGENT_EVENT_TYPES,
  SeqCounter,
  type SeqEvent,
  assertEventOrder,
  validateEventOrder,
} from "./event-seq";

function ev(seq: number, type: string, toolCallId?: string): SeqEvent {
  return { seq, type: type as SeqEvent["type"], toolCallId };
}

const HAPPY: SeqEvent[] = [
  ev(0, "run_created"),
  ev(1, "workspace_provisioning"),
  ev(2, "workspace_ready"),
  ev(3, "agent_started"),
  ev(4, "llm_attempt_started"),
  ev(5, "llm_attempt_succeeded"),
  ev(6, "model_step"),
  ev(7, "tool_call_started", "t1"),
  ev(8, "tool_call_completed", "t1"),
  ev(9, "run_completed"),
];

describe("event-seq — 类型集合", () => {
  it("包含 data-model §3 列出的关键事件类型", () => {
    for (const t of [
      "run_created",
      "agent_started",
      "llm_attempt_started",
      "llm_attempt_timeout",
      "llm_attempt_succeeded",
      "model_step",
      "tool_call_started",
      "tool_call_completed",
      "tool_call_failed",
      "run_completed",
      "run_failed",
      "run_timeout",
      "cancel_requested",
      "run_cancelled",
      "agent_heartbeat",
    ]) {
      expect(AGENT_EVENT_TYPES).toContain(t);
    }
  });
});

describe("event-seq — happy path 合法", () => {
  it("典型完整序列通过校验", () => {
    const r = validateEventOrder(HAPPY);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(() => assertEventOrder(HAPPY)).not.toThrow();
  });
});

describe("event-seq — seq 单调与唯一", () => {
  it("乱序（非单调递增）被拒", () => {
    const r = validateEventOrder([
      ev(0, "run_created"),
      ev(2, "agent_started"),
      ev(1, "model_step"),
    ]);
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toMatch(/monoton|单调|order/i);
  });

  it("seq 重复被拒", () => {
    const r = validateEventOrder([
      ev(0, "run_created"),
      ev(1, "agent_started"),
      ev(1, "model_step"),
    ]);
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toMatch(/duplicate|unique|重复/i);
  });
});

describe("event-seq — 偏序：run_created 早于 agent_started", () => {
  it("agent_started 早于 run_created 被拒", () => {
    const r = validateEventOrder([
      ev(0, "agent_started"),
      ev(1, "run_created"),
    ]);
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toMatch(/run_created.*agent_started/);
  });
});

describe("event-seq — 偏序：tool_call_started 早于其 completed/failed", () => {
  it("completed 无对应 started 被拒", () => {
    const r = validateEventOrder([
      ev(0, "run_created"),
      ev(1, "agent_started"),
      ev(2, "tool_call_completed", "t1"),
    ]);
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toMatch(/t1/);
  });

  it("started 与 completed 的 toolCallId 必须配对（不同 id 不算配对）", () => {
    const r = validateEventOrder([
      ev(0, "run_created"),
      ev(1, "agent_started"),
      ev(2, "tool_call_started", "t1"),
      ev(3, "tool_call_completed", "t2"),
    ]);
    expect(r.valid).toBe(false);
  });

  it("tool_call_failed 也算合法收尾", () => {
    const r = validateEventOrder([
      ev(0, "run_created"),
      ev(1, "agent_started"),
      ev(2, "tool_call_started", "t1"),
      ev(3, "tool_call_failed", "t1"),
      ev(4, "run_failed"),
    ]);
    expect(r.valid).toBe(true);
  });
});

describe("event-seq — 终态守卫：终态后不再追加普通事件", () => {
  it("run_completed 之后再有 model_step 被拒", () => {
    const r = validateEventOrder([
      ev(0, "run_created"),
      ev(1, "agent_started"),
      ev(2, "run_completed"),
      ev(3, "model_step"),
    ]);
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toMatch(/terminal|终态/i);
  });

  it("cancel_requested → run_cancelled 合法（cancel_requested 非终态）", () => {
    const r = validateEventOrder([
      ev(0, "run_created"),
      ev(1, "agent_started"),
      ev(2, "cancel_requested"),
      ev(3, "run_cancelled"),
    ]);
    expect(r.valid).toBe(true);
  });
});

describe("event-seq — SeqCounter", () => {
  it("从 0 单调递增", () => {
    const c = new SeqCounter();
    expect(c.next()).toBe(0);
    expect(c.next()).toBe(1);
    expect(c.next()).toBe(2);
    expect(c.peek()).toBe(3);
  });

  it("可从已有最大 seq 续号", () => {
    const c = new SeqCounter(5);
    expect(c.next()).toBe(5);
    expect(c.next()).toBe(6);
  });
});

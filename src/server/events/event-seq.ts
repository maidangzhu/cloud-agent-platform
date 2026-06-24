// AgentEvent 序列的纯逻辑：seq 单调唯一 + 偏序约束 + 终态守卫。
// 这是「事件流不可有损」的事实源约束（见 docs/data-model.md §3、architecture.md §8）。
// 纯逻辑、零依赖：event-store 落库前/测试中据此校验顺序正确性。

export const AGENT_EVENT_TYPES = [
  "run_created",
  "workspace_provisioning",
  "workspace_ready",
  "workspace_resumed",
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
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

// 终态事件：之后不得再追加任何事件。
const TERMINAL_EVENT_TYPES = new Set<AgentEventType>([
  "run_completed",
  "run_failed",
  "run_timeout",
  "run_cancelled",
]);

export interface SeqEvent {
  seq: number;
  type: AgentEventType;
  /** tool_call_started / completed / failed 用于配对的工具调用 id */
  toolCallId?: string;
}

export interface SeqValidation {
  valid: boolean;
  errors: string[];
}

/**
 * 校验事件数组（按追加顺序给出）的 seq 单调唯一与偏序约束。
 * 返回所有违规项；errors 为空即合法。
 */
export function validateEventOrder(events: SeqEvent[]): SeqValidation {
  const errors: string[] = [];

  // 1) seq 单调递增 + 唯一
  const seen = new Set<number>();
  for (let i = 0; i < events.length; i++) {
    const { seq } = events[i];
    if (seen.has(seq)) {
      errors.push(`duplicate seq: ${seq} (must be unique within run)`);
    }
    seen.add(seq);
    if (i > 0 && seq <= events[i - 1].seq) {
      errors.push(
        `seq not monotonically increasing at index ${i}: ${events[i - 1].seq} -> ${seq}`,
      );
    }
  }

  // 2) run_created 早于 agent_started
  const idxCreated = events.findIndex((e) => e.type === "run_created");
  const idxStarted = events.findIndex((e) => e.type === "agent_started");
  if (idxStarted !== -1) {
    if (idxCreated === -1 || idxCreated > idxStarted) {
      errors.push("run_created must precede agent_started");
    }
  }

  // 3) 每个工具的 tool_call_started 早于其 completed/failed
  const openTools = new Set<string>();
  for (const e of events) {
    if (e.type === "tool_call_started") {
      if (e.toolCallId) openTools.add(e.toolCallId);
    } else if (
      e.type === "tool_call_completed" ||
      e.type === "tool_call_failed"
    ) {
      const id = e.toolCallId ?? "<unknown>";
      if (!e.toolCallId || !openTools.has(e.toolCallId)) {
        errors.push(
          `${e.type} for toolCallId ${id} has no preceding tool_call_started`,
        );
      } else {
        openTools.delete(e.toolCallId);
      }
    }
  }

  // 4) 终态后不得再有任何事件
  const idxTerminal = events.findIndex((e) => TERMINAL_EVENT_TYPES.has(e.type));
  if (idxTerminal !== -1 && idxTerminal < events.length - 1) {
    const after = events[idxTerminal + 1];
    errors.push(
      `event ${after.type} appended after terminal event ${events[idxTerminal].type}`,
    );
  }

  return { valid: errors.length === 0, errors };
}

export function assertEventOrder(events: SeqEvent[]): void {
  const { valid, errors } = validateEventOrder(events);
  if (!valid) {
    throw new Error(`Invalid event order:\n - ${errors.join("\n - ")}`);
  }
}

/** run 内 seq 分配器：单调递增，可从已有最大 seq+? 续号。 */
export class SeqCounter {
  private current: number;
  constructor(start = 0) {
    this.current = start;
  }
  next(): number {
    return this.current++;
  }
  peek(): number {
    return this.current;
  }
}

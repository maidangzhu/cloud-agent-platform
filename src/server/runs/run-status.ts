// Run 状态机 —— 平台状态的事实源之一。
// 状态集合与合法转移以 docs/prd.md §5、docs/data-model.md 的 RunStatus 枚举为准。
// 纯逻辑、零依赖：可被 API / agent 编排层复用，单元测试无需 DB。

export const RUN_STATUSES = [
  "created",
  "provisioning_workspace",
  "running",
  "completed",
  "failed",
  "timeout",
  "cancel_requested",
  "cancelled",
  "interrupted",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

// 终态：到达后不再追加普通运行事件，也不允许再转移。
export const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "timeout",
  "cancelled",
  "interrupted",
] as const satisfies readonly RunStatus[];

const TERMINAL_SET = new Set<RunStatus>(TERMINAL_RUN_STATUSES);

// 合法转移表。终态映射到空数组（终态守卫）。
// created → provisioning_workspace → running → completed 为主链路；
// 失败 / 超时 / 取消请求 / 中断为分支。cancel_requested 是「取消已请求、等下一轮 abort」
// 的中间态，可能在 abort 生效前 race 到 completed/failed，故一并允许。
const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  created: ["provisioning_workspace", "cancel_requested", "failed"],
  provisioning_workspace: ["running", "failed", "timeout", "cancel_requested"],
  running: ["completed", "failed", "timeout", "cancel_requested", "interrupted"],
  cancel_requested: ["cancelled", "completed", "failed", "interrupted"],
  completed: [],
  failed: [],
  timeout: [],
  cancelled: [],
  interrupted: [],
};

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_SET.has(status);
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) {
    throw new Error(`Illegal run status transition: ${from} -> ${to}`);
  }
}

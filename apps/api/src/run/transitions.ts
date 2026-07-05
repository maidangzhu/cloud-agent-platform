// RunStatus 纯函数状态机（Step 6.1，见 docs/state-machines.md §1，含
// ADR-0019 的 waiting_for_input）。不接数据库——具体的原子 UPDATE
// 封装（transitionRun）是 Step 6.2 的内容，这里只是"这次转移合不合法"
// 的判断本身。

export type RunStatus =
  | "created"
  | "provisioning_sandbox"
  | "running"
  | "waiting_for_input"
  | "cancel_requested"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled"
  | "interrupted";

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "completed",
  "failed",
  "timeout",
  "cancelled",
  "interrupted",
];

// 合法转移表，逐条对应 docs/state-machines.md §1"状态转移"小节列出的
// 全部箭头，不多不少。终态在这里显式给空数组（终态拒绝任何转移）。
const LEGAL_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  created: ["provisioning_sandbox", "cancel_requested", "failed"],
  provisioning_sandbox: ["running", "cancel_requested", "failed", "timeout"],
  running: [
    "cancel_requested",
    "completed",
    "failed",
    "timeout",
    "interrupted",
    "waiting_for_input",
  ],
  waiting_for_input: ["cancel_requested", "completed", "interrupted"],
  cancel_requested: ["cancelled", "failed", "timeout"],
  completed: [],
  failed: [],
  timeout: [],
  cancelled: [],
  interrupted: [],
};

export function isLegalTransition(from: RunStatus, to: RunStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

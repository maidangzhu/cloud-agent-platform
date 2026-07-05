// DerivedUiState 纯函数（Step 6.1，见 docs/state-machines.md §2）。从
// RunStatus 和心跳新鲜度推导前端展示状态，不接数据库。

import type { RunStatus } from "./transitions";

export type DerivedUiState =
  | "idle"
  | "running"
  | "possibly_running"
  | "cancelling"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled"
  | "interrupted";

// docs/state-machines.md §2"新鲜度阈值"：fresh 定义为 heartbeat age <= 30s。
const FRESH_THRESHOLD_MS = 30_000;

function isFresh(referenceAt: Date | null | undefined, now: Date): boolean {
  if (!referenceAt) return false;
  return now.getTime() - referenceAt.getTime() <= FRESH_THRESHOLD_MS;
}

/**
 * @param createdAt 仅用于 provisioning_sandbox 状态的兜底新鲜度判断——这个
 *   阶段 sandbox runner 还没启动，通常还没有 heartbeat，用 createdAt 顶替
 *   （见规则"provisioning_sandbox 且 heartbeat 新鲜或 createdAt 很近 ->
 *   running"）。其它状态忽略这个参数。
 */
export function deriveUiState(
  status: RunStatus,
  lastHeartbeatAt: Date | null,
  now: Date,
  createdAt?: Date | null,
): DerivedUiState {
  switch (status) {
    case "created":
      return "idle";
    case "provisioning_sandbox":
      return isFresh(lastHeartbeatAt ?? createdAt, now)
        ? "running"
        : "possibly_running";
    case "running":
      return isFresh(lastHeartbeatAt, now) ? "running" : "possibly_running";
    case "waiting_for_input":
      // 直接映射，不依赖 heartbeat——sandbox 进程已正常退出，没有 heartbeat
      // 可看（ADR-0019）。
      return "waiting_for_input";
    case "cancel_requested":
      return "cancelling";
    case "completed":
    case "failed":
    case "timeout":
    case "cancelled":
    case "interrupted":
      // 终态直接映射自身，忽略 heartbeat 新鲜度。
      return status;
  }
}

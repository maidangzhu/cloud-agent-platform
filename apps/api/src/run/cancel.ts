// Run 取消（Step 6.3，见 docs/api-contract.md §5.4"只有非终态 run（含
// waiting_for_input）可以 cancel"、docs/state-machines.md §1）。
//
// 直接复用 transitionRun：cancel 本质上就是一次到 cancel_requested 的
// 条件转移，fromStatuses 覆盖所有允许发起 cancel 的状态。已经是终态或
// 已经是 cancel_requested 的 run，转移条件不满足，返回 applied: false，
// 路由层据此映射成 RUN_NOT_CANCELABLE（不区分"已经是终态"和"已经在
// cancel_requested"两种子情况——都是"不能再 cancel"）。

import { transitionRun } from "./transition-run";

const CANCELABLE_FROM_STATUSES = [
  "created",
  "provisioning_sandbox",
  "running",
  "waiting_for_input",
] as const;

export async function cancelRun(runId: string): Promise<{ applied: boolean }> {
  return transitionRun(runId, "cancel_requested", CANCELABLE_FROM_STATUSES);
}

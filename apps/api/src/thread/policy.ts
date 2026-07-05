// Thread 纯逻辑：archive 策略（Step 5.1，见 docs/testing-strategy.md
// §4.3 unit 3-4，同构 workspace/policy.ts）。具体的原子拒绝（ADR-0018
// insert-select）在 run 创建路由实现时接入（Group 6，复用同一模式），
// 这里只是策略判断本身的纯函数。

export type ThreadStatus = "active" | "archived";

/** 归档的 thread 不能启动新 run。 */
export function canStartRunInThread(status: ThreadStatus): boolean {
  return status === "active";
}

/** 归档的 thread 仍然可读。 */
export function canReadThread(_status: ThreadStatus): boolean {
  return true;
}

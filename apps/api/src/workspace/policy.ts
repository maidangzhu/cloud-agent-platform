// Workspace 纯逻辑：archive 策略（Step 4.1，见 docs/testing-strategy.md
// §4.2 unit 4-5）。不接数据库——具体的"归档判断+创建"原子性（ADR-0018
// insert-select）在 route 层实现，这里只是策略判断本身的纯函数。

export type WorkspaceStatus = "active" | "archived";

/** 归档的 workspace 不能创建新 thread/run。 */
export function canCreateInWorkspace(status: WorkspaceStatus): boolean {
  return status === "active";
}

/** 归档的 workspace 仍然可读。 */
export function canReadWorkspace(_status: WorkspaceStatus): boolean {
  return true;
}

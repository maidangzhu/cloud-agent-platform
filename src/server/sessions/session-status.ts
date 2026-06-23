// Session 状态机 —— active → archived（单向，archived 为终态）。
// 与 docs/data-model.md 的 SessionStatus 枚举一致。纯逻辑、零依赖。

export const SESSION_STATUSES = ["active", "archived"] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

const SESSION_TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  active: ["archived"],
  archived: [],
};

export function isArchivedSession(status: SessionStatus): boolean {
  return status === "archived";
}

export function canTransitionSession(
  from: SessionStatus,
  to: SessionStatus,
): boolean {
  return SESSION_TRANSITIONS[from].includes(to);
}

export function assertSessionTransition(
  from: SessionStatus,
  to: SessionStatus,
): void {
  if (!canTransitionSession(from, to)) {
    throw new Error(`Illegal session status transition: ${from} -> ${to}`);
  }
}

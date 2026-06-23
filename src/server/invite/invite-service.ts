// invite-service.ts — 邀请码校验。
// 有效码列表来自 INVITE_CODES 环境变量（逗号分隔明文）。
// 邀请码在数据库里以 SHA-256 hash 存储，不落明文。
import { createHash } from "node:crypto";

export function hashCode(code: string): string {
  return createHash("sha256").update(code.trim()).digest("hex");
}

export function isValidInviteCode(code: string): boolean {
  const list = (process.env.INVITE_CODES ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  return list.includes(code.trim());
}

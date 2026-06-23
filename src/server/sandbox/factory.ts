import { Sandbox as VercelSdkSandbox } from "@vercel/sandbox";
import { resolveVercelCredentials } from "./vercel-credentials";
import { VercelSandbox } from "./vercel-sandbox";

const DEFAULT_SANDBOX_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

export interface GetOrCreateOptions {
  /** 会话 id，用于命名沙箱（同一 session 跨 Run 复用同一 workspace）。 */
  sessionId: string;
  timeoutMs?: number;
}

export interface GetOrCreateResult {
  sandbox: VercelSandbox;
}

/** 由 sessionId 生成 project 内唯一、字符受限的命名沙箱名。 */
export function sandboxNameFor(sessionId: string): string {
  return `cap-${sessionId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/**
 * 按 sessionId getOrCreate 命名沙箱：活着则复用、回收则重建。
 * 沙箱初始化为空目录，用户可自由使用。
 */
export async function getOrCreateSandbox(
  opts: GetOrCreateOptions,
): Promise<GetOrCreateResult> {
  const creds = resolveVercelCredentials();
  if (!creds) {
    throw new Error(
      "Vercel credentials not available: set VERCEL_TOKEN, or VERCEL_OIDC_TOKEN (+ optional VERCEL_TEAM_ID/VERCEL_PROJECT_ID).",
    );
  }

  const name = sandboxNameFor(opts.sessionId);
  const sdk = await VercelSdkSandbox.getOrCreate({
    name,
    runtime: "node24",
    persistent: true,
    timeout: opts.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
    ...creds,
  });

  const sandbox = new VercelSandbox(sdk, { provider: "vercel", sandboxName: name });
  return { sandbox };
}

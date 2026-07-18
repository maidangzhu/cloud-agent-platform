import { Sandbox as VercelSdkSandbox } from "@vercel/sandbox";
import { resolveVercelCredentials } from "./vercel-credentials.js";
import { VercelSandbox } from "./vercel-sandbox.js";

const DEFAULT_SANDBOX_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟，与 Function maxDuration 对齐

export interface GetOrCreateOptions {
  /** 会话 id，用于命名沙箱（同一 session 跨 Run 复用同一 workspace）。 */
  sessionId: string;
  timeoutMs?: number;
}

export interface GetOrCreateResult {
  sandbox: VercelSandbox;
  created: boolean;
}

export function isSandboxNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /status code 404|not[_ -]?found/i.test(message);
}

export function resolveWorkspaceSandboxSource(
  env: Record<string, string | undefined> = process.env,
):
  | { runtime: "node24" }
  | { source: { type: "snapshot"; snapshotId: string } } {
  const snapshotId = env.VERCEL_BASE_SNAPSHOT_ID?.trim();
  return snapshotId
    ? { source: { type: "snapshot", snapshotId } }
    : { runtime: "node24" };
}

export function canReuseEphemeralSandbox(status: string): boolean {
  return status === "pending" || status === "running";
}

export async function disableWorkspaceSandboxPersistence(sandbox: {
  update(params: {
    persistent: boolean;
    keepLastSnapshots: null;
  }): Promise<void>;
}): Promise<void> {
  await sandbox.update({
    persistent: false,
    keepLastSnapshots: null,
  });
}

/** 由 sessionId 生成 project 内唯一、字符受限的命名沙箱名。 */
export function sandboxNameFor(sessionId: string): string {
  return `cap-${sessionId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/**
 * 按 sessionId 获取仍在运行的临时沙箱，否则从 golden snapshot（如配置）
 * 或 node24 runtime 新建。session 停止后文件系统直接丢弃，持久文件由
 * Control Plane 在下次 Run 启动前重新水合。
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
  const source = resolveWorkspaceSandboxSource();
  const commonCreateParams = {
    name,
    persistent: false,
    timeout: opts.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
    ...creds,
  } as const;
  let existing: VercelSdkSandbox | null = null;
  try {
    existing = await VercelSdkSandbox.get({ name, resume: false, ...creds });
  } catch (error) {
    if (!isSandboxNotFoundError(error)) throw error;
  }

  const reusable = existing && canReuseEphemeralSandbox(existing.status);
  if (existing && !reusable) {
    await existing.delete();
  }
  let sdk: VercelSdkSandbox;
  let created: boolean;
  if (reusable && existing) {
    sdk = existing;
    created = false;
  } else {
    sdk = await VercelSdkSandbox.create({
      ...commonCreateParams,
      ...source,
    });
    created = true;
  }
  await disableWorkspaceSandboxPersistence(sdk);
  const sandbox = new VercelSandbox(sdk, { provider: "vercel", sandboxName: name });
  return { sandbox, created };
}

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

export function createSandboxCreationTracker() {
  let created = false;
  return {
    onCreate: async () => {
      created = true;
    },
    wasCreated: () => created,
  };
}

export function isSandboxNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /status code 404|not[_ -]?found/i.test(message);
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
  const creation = createSandboxCreationTracker();
  const createParams = {
    name,
    runtime: "node24",
    persistent: true,
    timeout: opts.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
    ...creds,
  } as const;
  let sdk;
  try {
    sdk = await VercelSdkSandbox.getOrCreate({
      ...createParams,
      onCreate: creation.onCreate,
    });
  } catch (error) {
    if (!isSandboxNotFoundError(error)) throw error;
    sdk = await VercelSdkSandbox.create(createParams);
    await creation.onCreate();
  }

  const sandbox = new VercelSandbox(sdk, { provider: "vercel", sandboxName: name });
  return { sandbox, created: creation.wasCreated() };
}

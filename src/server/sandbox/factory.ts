import { Sandbox as VercelSdkSandbox } from "@vercel/sandbox";
import { DEMO_REPO_FILES, DEMO_REPO_SEED_MARKER } from "./demo-repo";
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
  /** 本次是否新建并 seed 了 demo-repo（true=新建，false=复用已存在沙箱）。 */
  seeded: boolean;
}

/** 由 sessionId 生成 project 内唯一、字符受限的命名沙箱名。 */
export function sandboxNameFor(sessionId: string): string {
  return `cap-${sessionId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/**
 * 按 sessionId getOrCreate 命名沙箱（① 文件延续）：活着则复用、回收则重建。
 * 新建（未 seed）时把 demo-repo seed 进 workspace；复用时跳过。
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
  const seeded = await ensureSeeded(sandbox);
  return { sandbox, seeded };
}

/**
 * 幂等 seed：标记文件存在则跳过（复用场景）；否则写入 demo-repo 全部文件 + 标记。
 * 返回是否实际执行了 seed。
 */
async function ensureSeeded(sandbox: VercelSandbox): Promise<boolean> {
  let alreadySeeded = false;
  try {
    await sandbox.readFile(DEMO_REPO_SEED_MARKER);
    alreadySeeded = true;
  } catch {
    alreadySeeded = false;
  }
  if (alreadySeeded) return false;

  await sandbox.writeFilesBatch([
    ...Object.entries(DEMO_REPO_FILES).map(([path, content]) => ({
      path,
      content,
    })),
    { path: DEMO_REPO_SEED_MARKER, content: "seeded\n" },
  ]);
  return true;
}

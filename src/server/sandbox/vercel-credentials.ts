// 解析 Vercel Sandbox 的显式 credentials，绕开会过期、需 `vercel link` 才能刷新的
// OIDC 默认路径（见 memory: vercel-sandbox-auth-oidc）。
//
// 凭据来源优先级：
//   token   : VERCEL_TOKEN（个人 access token，永不过期，首选）→ 退回 VERCEL_OIDC_TOKEN
//   teamId  : VERCEL_TEAM_ID → 从 OIDC JWT 的 owner_id 解析
//   projectId: VERCEL_PROJECT_ID → 从 OIDC JWT 的 project_id 解析
//
// 三者齐备才返回；否则返回 null（调用方据此跳过真实沙箱）。
// @vercel/sandbox 的 Sandbox.create/getOrCreate 接受 { token, teamId, projectId }，
// 命中 getCredentialsFromParams 直接采用，不触发 OIDC 刷新。

export interface VercelCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = normalized.length % 4;
    const padded = pad === 0 ? normalized : normalized + "=".repeat(4 - pad);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function resolveVercelCredentials(
  env: NodeJS.ProcessEnv = process.env,
): VercelCredentials | null {
  const oidc = env.VERCEL_OIDC_TOKEN;
  const payload = oidc ? decodeJwtPayload(oidc) : null;

  const token = env.VERCEL_TOKEN || oidc;
  const teamId =
    env.VERCEL_TEAM_ID ||
    (typeof payload?.owner_id === "string" ? payload.owner_id : undefined);
  const projectId =
    env.VERCEL_PROJECT_ID ||
    (typeof payload?.project_id === "string" ? payload.project_id : undefined);

  if (token && teamId && projectId) {
    return { token, teamId, projectId };
  }
  return null;
}

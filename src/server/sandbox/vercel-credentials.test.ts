import { describe, expect, it } from "vitest";
import { resolveVercelCredentials } from "./vercel-credentials";

// 构造一个 payload 为 {owner_id, project_id} 的假 JWT（仅 header.payload.sig，
// 不验签，符合 resolveVercelCredentials 只解析 payload 的行为）。
function fakeOidc(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

describe("resolveVercelCredentials", () => {
  it("PAT 优先：VERCEL_TOKEN + 显式 team/project", () => {
    const c = resolveVercelCredentials({
      VERCEL_TOKEN: "pat_xxx",
      VERCEL_TEAM_ID: "team_1",
      VERCEL_PROJECT_ID: "prj_1",
    } as NodeJS.ProcessEnv);
    expect(c).toEqual({ token: "pat_xxx", teamId: "team_1", projectId: "prj_1" });
  });

  it("从 OIDC JWT 解析 teamId/projectId，token 仍优先用 PAT", () => {
    const oidc = fakeOidc({ owner_id: "team_jwt", project_id: "prj_jwt" });
    const c = resolveVercelCredentials({
      VERCEL_TOKEN: "pat_xxx",
      VERCEL_OIDC_TOKEN: oidc,
    } as NodeJS.ProcessEnv);
    expect(c).toEqual({
      token: "pat_xxx",
      teamId: "team_jwt",
      projectId: "prj_jwt",
    });
  });

  it("只有 OIDC token 时，token 退回用 OIDC、id 从 JWT 解析", () => {
    const oidc = fakeOidc({ owner_id: "team_jwt", project_id: "prj_jwt" });
    const c = resolveVercelCredentials({
      VERCEL_OIDC_TOKEN: oidc,
    } as NodeJS.ProcessEnv);
    expect(c).toEqual({
      token: oidc,
      teamId: "team_jwt",
      projectId: "prj_jwt",
    });
  });

  it("显式 env 覆盖 JWT 内的 id", () => {
    const oidc = fakeOidc({ owner_id: "team_jwt", project_id: "prj_jwt" });
    const c = resolveVercelCredentials({
      VERCEL_OIDC_TOKEN: oidc,
      VERCEL_TEAM_ID: "team_env",
      VERCEL_PROJECT_ID: "prj_env",
    } as NodeJS.ProcessEnv);
    expect(c?.teamId).toBe("team_env");
    expect(c?.projectId).toBe("prj_env");
  });

  it("凭据不全返回 null", () => {
    expect(resolveVercelCredentials({} as NodeJS.ProcessEnv)).toBeNull();
    // 有 token 但缺 team/project（且无 OIDC 可解析）
    expect(
      resolveVercelCredentials({
        VERCEL_TOKEN: "pat_xxx",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});

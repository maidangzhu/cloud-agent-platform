import { prisma } from "@/server/db/client";
import { isValidInviteCode } from "@/server/invite/invite-service";
import { ApiCode, apiJson, fail, ok } from "@/lib/api-contract";
import type { InviteVerifyData } from "@/lib/api-contract";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    const f = fail(ApiCode.BAD_REQUEST, "invalid JSON");
    return apiJson(f.body, f.status);
  }

  const code = (body as any)?.code;
  if (typeof code !== "string" || !code.trim()) {
    const f = fail(ApiCode.BAD_REQUEST, "code is required");
    return apiJson(f.body, f.status);
  }

  if (!isValidInviteCode(code)) {
    const f = fail(ApiCode.UNAUTHORIZED, "邀请码无效");
    return apiJson(f.body, f.status);
  }

  return apiJson(ok<InviteVerifyData>({ valid: true }));
}

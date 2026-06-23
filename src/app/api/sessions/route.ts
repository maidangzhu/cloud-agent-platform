import { prisma } from "@/server/db/client";
import { isValidInviteCode, hashCode } from "@/server/invite/invite-service";
import { toSessionDTO } from "@/server/runs/run-service";
import { ApiCode, apiJson, fail, ok } from "@/lib/api-contract";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    const f = fail(ApiCode.BAD_REQUEST, "invalid JSON");
    return apiJson(f.body, f.status);
  }

  const { inviteCode, prompt } = (body as any) ?? {};
  if (typeof inviteCode !== "string" || !inviteCode.trim()) {
    const f = fail(ApiCode.BAD_REQUEST, "inviteCode is required");
    return apiJson(f.body, f.status);
  }
  if (!isValidInviteCode(inviteCode)) {
    const f = fail(ApiCode.UNAUTHORIZED, "邀请码无效");
    return apiJson(f.body, f.status);
  }

  const title =
    typeof prompt === "string" && prompt.trim()
      ? prompt.trim().slice(0, 100)
      : "New session";

  const session = await prisma.session.create({
    data: {
      title,
      inviteCodeHash: hashCode(inviteCode),
      status: "active",
    },
  });

  return apiJson(ok({ session: toSessionDTO(session) }), 201);
}

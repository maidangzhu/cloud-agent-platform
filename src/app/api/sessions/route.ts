import { prisma } from "@/server/db/client";
import { isValidInviteCode, hashCode } from "@/server/invite/invite-service";
import { toSessionDTO } from "@/server/runs/run-service";
import { ApiCode, apiJson, fail, ok } from "@/lib/api-contract";

// GET /api/sessions - 获取用户的所有 sessions
export async function GET(req: Request) {
  const inviteCode = req.headers.get("x-invite-code");
  if (typeof inviteCode !== "string" || !inviteCode.trim()) {
    const f = fail(ApiCode.BAD_REQUEST, "x-invite-code header is required");
    return apiJson(f.body, f.status);
  }
  if (!isValidInviteCode(inviteCode)) {
    const f = fail(ApiCode.UNAUTHORIZED, "邀请码无效");
    return apiJson(f.body, f.status);
  }

  const sessions = await prisma.session.findMany({
    where: { inviteCodeHash: hashCode(inviteCode) },
    orderBy: { createdAt: "desc" },
  });

  return apiJson(ok({ sessions: sessions.map(toSessionDTO) }));
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    const f = fail(ApiCode.BAD_REQUEST, "invalid JSON");
    return apiJson(f.body, f.status);
  }

  const { inviteCode, prompt, title } = (body as any) ?? {};
  if (typeof inviteCode !== "string" || !inviteCode.trim()) {
    const f = fail(ApiCode.BAD_REQUEST, "inviteCode is required");
    return apiJson(f.body, f.status);
  }
  if (!isValidInviteCode(inviteCode)) {
    const f = fail(ApiCode.UNAUTHORIZED, "邀请码无效");
    return apiJson(f.body, f.status);
  }

  // 优先使用 title，否则用 prompt 的前 100 字符，最后兜底为 "New session"
  const sessionTitle =
    typeof title === "string" && title.trim()
      ? title.trim().slice(0, 100)
      : typeof prompt === "string" && prompt.trim()
      ? prompt.trim().slice(0, 100)
      : "New session";

  const now = new Date();
  const session = await prisma.session.create({
    data: {
      id: crypto.randomUUID(),
      title: sessionTitle,
      inviteCodeHash: hashCode(inviteCode),
      status: "active",
      updatedAt: now,
    },
  });

  return apiJson(ok({ session: toSessionDTO(session) }), 201);
}

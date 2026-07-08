// 受保护路由 helper（Step 3.2）。用 auth.api.getSession 服务端读取当前
// session（标准 Better Auth 用法：传入请求 headers，不是走 HTTP 往返
// /api/auth/get-session，是同进程内直接调用）。
// 参考：https://better-auth.com/docs/concepts/api

import type { Context } from "hono";
import { auth } from "./auth.js";

export type CurrentUser = {
  id: string;
  email: string;
  name: string;
};

/**
 * 返回当前登录用户，未登录返回 null。不抛错——由调用方（路由 handler）
 * 决定未登录时的响应形状（如统一响应信封 + 401）。
 */
export async function getCurrentUser(c: Context): Promise<CurrentUser | null> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return null;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
  };
}

/**
 * 受保护路由用：未登录时直接返回 401 响应（统一信封，见
 * docs/api-contract.md §1/§2），登录时返回 CurrentUser。
 * 用法：const user = await requireUser(c); if (user instanceof Response) return user;
 */
export async function requireUser(
  c: Context,
): Promise<CurrentUser | Response> {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json(
      { code: 1002, message: "unauthorized", data: null },
      401,
    );
  }
  return user;
}

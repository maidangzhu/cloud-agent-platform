// Better Auth 实例配置（Step 3.1，ADR-0022：Auth 挂在 apps/api，不挂在
// apps/web）。用 Prisma adapter 连 packages/db 的同一个数据库。
//
// 官方 Hono 集成方式（见 https://better-auth.com/docs/integrations/hono）：
// 在 app.ts 里用 app.on(["POST", "GET"], "/api/auth/*", ...) 挂载 auth.handler。
//
// 环境变量：
//   BETTER_AUTH_SECRET  用于签名 session token 的随机密钥
//   BETTER_AUTH_URL     本地开发是 http://localhost:8787（Hono 监听端口）

import { prismaAdapter } from "better-auth/adapters/prisma";
import { betterAuth } from "better-auth";
import { prisma } from "@cap/db";

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:8787",
  trustedOrigins: getTrustedOrigins(),
  // Better Auth 默认关闭邮箱密码注册/登录。P0 先用最基础的邮箱密码方式
  // 验证 auth 链路可用，后续引入哪种登录方式（OAuth/魔法链接等）留给
  // 后续 Group（不在 Step 3.1 范围内）。
  emailAndPassword: {
    enabled: true,
  },
  // v1 的 Prisma schema 里已经有一个业务 model 叫 Session（会话容器，
  // 见 docs/glossary.md 的明确警告："不要把业务对话对象命名为 Session"）。
  // Better Auth 默认生成的认证 session model 名字也叫 "session"，@better-auth/cli
  // generate 会直接把两者合并成一个 model，产生字段混杂的错误结果（已实测踩坑）。
  // 用 modelName 显式改名为 AuthSession，避免与 v1/v2 的业务概念冲突。
  session: {
    // Better Auth 的 prisma adapter 用 modelName 原样去 db[modelName] 取
    // Prisma 委托属性（如 prisma.authSession），委托属性名是首字母小写驼峰，
    // 不是 Prisma model 声明名（AuthSession）。必须写小写开头，否则报
    // "Model AuthSession does not exist"（已实测踩坑）。
    modelName: "authSession",
  },
});

function getTrustedOrigins() {
  return [
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:3002",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
    "http://127.0.0.1:3002",
    process.env.WEB_ORIGIN,
    process.env.NEXT_PUBLIC_APP_URL,
    ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ].filter((origin): origin is string => Boolean(origin));
}

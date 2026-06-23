import { describe, expect, it } from "vitest";
import { Sandbox } from "@vercel/sandbox";
import { resolveVercelCredentials } from "./vercel-credentials";

// 从本地拉起真实 Vercel microVM（Firecracker）。用显式 credentials（VERCEL_TOKEN
// 优先，退回 VERCEL_OIDC_TOKEN；teamId/projectId 从 env 或 OIDC JWT 解析），
// 绕开会过期、需 `vercel link` 才能刷新的 OIDC 默认路径。
// 无可用凭据则跳过（不报错）。运行：pnpm test:integration
const creds = resolveVercelCredentials();

describe.skipIf(!creds)("Vercel Sandbox 集成 — 本地拉起远端 microVM", () => {
  it("create → runCommand(echo) → 文件读写 → stop", async () => {
    const sandbox = await Sandbox.create({
      runtime: "node24",
      timeout: 60_000, // ms
      ...creds!,
    });

    try {
      // 1) 远端执行命令
      const echo = await sandbox.runCommand({
        cmd: "echo",
        args: ["hello-from-sandbox"],
      });
      expect(echo.exitCode).toBe(0);
      expect((await echo.stdout()).trim()).toContain("hello-from-sandbox");

      // 2) 写文件 → 再用命令读回，验证隔离文件系统可用
      await sandbox.writeFiles([
        {
          path: "/vercel/sandbox/probe.txt",
          content: Buffer.from("sandbox-fs-ok"),
        },
      ]);
      const cat = await sandbox.runCommand({
        cmd: "cat",
        args: ["/vercel/sandbox/probe.txt"],
      });
      expect(cat.exitCode).toBe(0);
      expect((await cat.stdout()).trim()).toBe("sandbox-fs-ok");
    } finally {
      await sandbox.stop();
    }
  });
});

import { afterAll, describe, expect, it } from "vitest";
import { getOrCreateSandbox } from "./factory";
import { resolveVercelCredentials } from "./vercel-credentials";
import type { VercelSandbox } from "./vercel-sandbox";

// 连真实 Vercel microVM。无凭据则整组跳过。运行：pnpm test:integration
// 全组共享一个命名沙箱（beforeAll 隐式建于第一个用例，afterAll 停止），
// 避免每个用例都冷启动一个 microVM。
const creds = resolveVercelCredentials();
const sessionId = `it-${Date.now()}`;

describe.skipIf(!creds)("VercelSandbox + factory 集成（真沙箱）", () => {
  let sandbox: VercelSandbox;

  afterAll(async () => {
    if (sandbox) await sandbox.stop();
  });

  it("getOrCreate 新建并 seed demo-repo", async () => {
    const r = await getOrCreateSandbox({ sessionId });
    sandbox = r.sandbox;
    expect(r.seeded).toBe(true);
    const store = await sandbox.readFile("src/store.ts");
    expect(store).toContain("FIXME");
  });

  it("readdir 列出 workspace 根（含文件与目录类型）", async () => {
    const entries = await sandbox.readdir(".");
    const names = entries.map((e) => e.name);
    expect(names).toContain("README.md");
    expect(names).toContain("src");
    expect(entries.find((e) => e.name === "src")?.type).toBe("dir");
    expect(entries.find((e) => e.name === "README.md")?.type).toBe("file");
  });

  it("writeFile + readFile 往返（自动建父目录）", async () => {
    await sandbox.writeFile("notes/out.txt", "hello-sandbox");
    expect(await sandbox.readFile("notes/out.txt")).toBe("hello-sandbox");
  });

  it("path-guard 拒绝越权读/写", async () => {
    await expect(sandbox.readFile("../../etc/passwd")).rejects.toThrow();
    await expect(sandbox.writeFile("../evil.txt", "x")).rejects.toThrow();
  });

  it("exec 运行命令并返回结果", async () => {
    const r = await sandbox.exec("echo hi && ls src");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hi");
    expect(r.stdout).toContain("index.ts");
  });

  it("readFile 不存在的文件抛错", async () => {
    await expect(sandbox.readFile("nope.txt")).rejects.toThrow(/not found/i);
  });

  it("同 sessionId 复用沙箱：seeded=false 且文件延续", async () => {
    const r2 = await getOrCreateSandbox({ sessionId });
    expect(r2.seeded).toBe(false);
    // 第一次写入的文件在复用的沙箱里仍可见（① 文件延续）
    expect(await r2.sandbox.readFile("notes/out.txt")).toBe("hello-sandbox");
  });
});

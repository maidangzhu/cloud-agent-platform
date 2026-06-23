import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getOrCreateSandbox } from "../sandbox/factory";
import { resolveVercelCredentials } from "../sandbox/vercel-credentials";
import type { VercelSandbox } from "../sandbox/vercel-sandbox";
import { type ToolContext, ToolRejectedError, createTools } from "./registry";
import type { AgentTool } from "@earendil-works/pi-agent-core";

// 连真实 Vercel microVM。无凭据则跳过。运行：pnpm test:integration
const creds = resolveVercelCredentials();
const sessionId = `tools-${Date.now()}`;

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? "").join("");
}

describe.skipIf(!creds)("工具层集成（真沙箱）", () => {
  let sandbox: VercelSandbox;
  let tools: AgentTool[];
  const get = (name: string): AgentTool => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool not found: ${name}`);
    return t;
  };
  const run = (name: string, params: unknown) =>
    get(name).execute("test-call", params as never);

  beforeAll(async () => {
    const r = await getOrCreateSandbox({ sessionId });
    sandbox = r.sandbox;
    tools = createTools({ sandbox } satisfies ToolContext);
  });

  afterAll(async () => {
    if (sandbox) await sandbox.stop();
  });

  it("list_files 列出根目录", async () => {
    const res = await run("list_files", { path: "." });
    const text = textOf(res);
    expect(text).toContain("README.md");
    expect(text).toContain("src/");
  });

  it("read_file 读到 demo 文件内容", async () => {
    const res = await run("read_file", { path: "src/store.ts" });
    expect(textOf(res)).toContain("FIXME");
  });

  it("read_file 不存在文件 → 抛错（Pi 转 error result）", async () => {
    await expect(run("read_file", { path: "nope.ts" })).rejects.toThrow(
      /not found/i,
    );
  });

  it("read_file 越权路径 → 抛错", async () => {
    await expect(
      run("read_file", { path: "../../etc/passwd" }),
    ).rejects.toThrow();
  });

  it("search_text 命中 demo-repo 里的 TODO", async () => {
    const res = await run("search_text", { query: "TODO" });
    const text = textOf(res);
    expect(text).toContain("TODO");
    // 至少命中多个文件里的 TODO
    expect((res as { details: { count: number } }).details.count).toBeGreaterThan(
      1,
    );
    expect(text).toMatch(/src\/.*:\d+:/); // file:line 格式
  });

  it("write_file 写入后可读回", async () => {
    const res = await run("write_file", {
      path: "out/report.md",
      content: "# Report\n- done",
    });
    expect(textOf(res)).toMatch(/Wrote \d+ bytes/);
    const back = await run("read_file", { path: "out/report.md" });
    expect(textOf(back)).toContain("# Report");
  });

  it("write_file 越权路径 → 抛错", async () => {
    await expect(
      run("write_file", { path: "../evil.txt", content: "x" }),
    ).rejects.toThrow();
  });

  it("run_command 白名单命令正常执行", async () => {
    const res = await run("run_command", { command: "ls src" });
    expect(textOf(res)).toContain("index.ts");
    expect((res as { details: { exitCode: number } }).details.exitCode).toBe(0);
  });

  it("run_command 高风险命令被 policy 拒绝", async () => {
    await expect(
      run("run_command", { command: "rm -rf /" }),
    ).rejects.toBeInstanceOf(ToolRejectedError);
  });

  it("run_command 非白名单命令被拒绝", async () => {
    await expect(
      run("run_command", { command: "node -e 1" }),
    ).rejects.toBeInstanceOf(ToolRejectedError);
  });

  // 超时与截断是 sandbox.exec 的原语，工具直接透传；在此一并验证。
  it("exec 超时抛 SandboxTimeoutError（工具的 run_command 透传）", async () => {
    await expect(
      sandbox.exec("sleep 3", { timeoutMs: 800 }),
    ).rejects.toThrow(/timed out/i);
  });

  it("exec 超长输出被截断", async () => {
    const res = await sandbox.exec("seq 20000");
    expect(res.truncated).toBe(true);
    expect(res.stdout.length).toBeLessThan(51_000);
  });
});

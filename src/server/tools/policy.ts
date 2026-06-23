// run_command 策略守卫 —— 宽松模式：只拦截高风险命令，其他全部放行。
// 接在 Pi 的 beforeToolCall 上：被拒绝的命令绝不触达 sandbox。
// 纯逻辑、零依赖。
//
// 策略调整（2024-06-23）：改为宽松模式以提高开发效率。
// - 移除白名单机制：除高风险命令外，所有命令都允许执行。
// - 保留高风险拒绝：rm -rf、sudo、网络破坏性操作等仍然拦截。
// - 沙箱隔离是主要安全边界，policy 只防止明显的破坏性操作。
//
// 判定顺序（任一命中即拒绝）：
//   1) 空命令
//   2) 命令替换 `$( )` / 反引号（防夹带高风险命令）
//   3) 高风险 denylist（rm -rf/sudo/dd/mkfs/shutdown/kill 等破坏性操作）

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

// 高风险命令模式：只拦截明确的破坏性操作。
// 网络命令（curl/wget/git clone/npx 等）已放行，沙箱网络隔离是安全边界。
const HIGH_RISK_PATTERNS: RegExp[] = [
  /\bsudo\b/,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*/, // rm -rf 或 rm -r（任何路径）
  /\brm\s+\//, // rm / 根路径
  /\brmdir\s+\//, // rmdir / 根路径
  /\bdd\b/, // dd 磁盘写入
  /\bmkfs/, // 格式化文件系统
  /\bshutdown\b/,
  /\breboot\b/,
  /\bhalt\b/,
  /\bkillall\b/, // killall 全杀
  /\bchmod\s+777/, // chmod 777 高危权限
  /\bchown\s+.*root/, // chown root 提权
  /\bmount\b/,
  /\bumount\b/,
  /:\(\)\s*\{/, // fork bomb
];

export function evaluateCommand(command: string): PolicyDecision {
  const cmd = command.trim();
  if (cmd === "") {
    return { allowed: false, reason: "empty command" };
  }

  // 命令替换：防止夹带高风险命令（如 ls `rm -rf /`）
  if (/\$\(|`/.test(cmd)) {
    return { allowed: false, reason: "command substitution is not allowed" };
  }

  // 高风险命令拦截：rm -rf /、sudo、dd、格式化等
  for (const re of HIGH_RISK_PATTERNS) {
    if (re.test(cmd)) {
      return {
        allowed: false,
        reason: `high-risk command rejected (matched ${re})`,
      };
    }
  }

  // 其他命令全部放行（沙箱隔离是主要安全边界）
  return { allowed: true };
}

export function isCommandAllowed(command: string): boolean {
  return evaluateCommand(command).allowed;
}

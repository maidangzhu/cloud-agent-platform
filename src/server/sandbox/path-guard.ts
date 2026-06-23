// path guard —— 把任意用户/模型给的路径归一化并约束在 workspace root 内。
// 纯字符串归一化（不触碰文件系统），接口层即拦截 `../` 与绝对路径越权，
// 不依赖沙箱本身的隔离。VercelSandbox 在工具层复用这套保护。
//
// 限制（P0）：基于字符串归一化，不解析符号链接。真实 symlink 逃逸的防护
// 留给沙箱实现层（如 realpath 校验），见 docs/sandbox-research.md §7。

import path from "node:path";

/**
 * 判断 inputPath 归一化后是否落在 root 内（含 root 自身）。
 * 空字符串视为无目标，返回 false。
 */
export function isWithinRoot(root: string, inputPath: string): boolean {
  if (inputPath === "") return false;
  const abs = path.resolve(root, inputPath);
  const rel = path.relative(root, abs);
  // rel === "" 表示正是 root；否则不得以 ".." 开头、也不得是绝对路径。
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 归一化并返回 root 内的绝对路径；越权则抛错。
 * 工具层应始终用其返回值作为真正的文件操作路径。
 */
export function resolveWithinRoot(root: string, inputPath: string): string {
  if (!isWithinRoot(root, inputPath)) {
    throw new Error(
      `Path escapes workspace root: ${JSON.stringify(inputPath)} (root: ${root})`,
    );
  }
  return path.resolve(root, inputPath);
}

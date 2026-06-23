import path from "node:path";
import type { Sandbox as VercelSdkSandbox } from "@vercel/sandbox";
import type {
  DirEntry,
  ExecOptions,
  ExecResult,
  Sandbox,
  SandboxState,
} from "./interface";
import { resolveWithinRoot } from "./path-guard";

// Vercel 沙箱的固定工作目录。
export const VERCEL_WORKING_DIR = "/vercel/sandbox";

// 命令 stdout/stderr 截断上限（防上下文爆炸），借鉴 Open Agents 的 50k。
const MAX_OUTPUT_LENGTH = 50_000;

// exec 默认超时。
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

/** 命令执行超时，由 exec 抛出；run_command 工具据此映射为 ToolCall timeout。 */
export class SandboxTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxTimeoutError";
  }
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_LENGTH) return { text, truncated: false };
  return {
    text: text.slice(0, MAX_OUTPUT_LENGTH) + "\n…[truncated]",
    truncated: true,
  };
}

/**
 * VercelSandbox —— 用 @vercel/sandbox microVM 实现统一 Sandbox 接口。
 * 所有文件路径经 path-guard 约束在 workingDir 内；命令带超时与输出截断。
 */
export class VercelSandbox implements Sandbox {
  readonly workingDir = VERCEL_WORKING_DIR;

  constructor(
    private readonly sdk: VercelSdkSandbox,
    private readonly state: SandboxState,
  ) {}

  async readFile(filePath: string): Promise<string> {
    const abs = resolveWithinRoot(this.workingDir, filePath);
    const buf = await this.sdk.readFileToBuffer({ path: abs });
    if (buf === null) {
      throw new Error(`File not found: ${filePath}`);
    }
    return buf.toString("utf8");
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await this.writeFilesBatch([{ path: filePath, content }]);
  }

  /**
   * 批量写文件（一次 mkdir -p 父目录 + 一次 writeFiles）。
   * 非接口方法，供 factory 高效 seed demo-repo。
   */
  async writeFilesBatch(
    files: { path: string; content: string }[],
  ): Promise<void> {
    const resolved = files.map((f) => ({
      path: resolveWithinRoot(this.workingDir, f.path),
      content: f.content,
    }));
    const dirs = [...new Set(resolved.map((f) => path.dirname(f.path)))];
    await this.sdk.runCommand({ cmd: "mkdir", args: ["-p", ...dirs] });
    await this.sdk.writeFiles(
      resolved.map((f) => ({ path: f.path, content: f.content })),
    );
  }

  async readdir(dirPath: string): Promise<DirEntry[]> {
    const abs = resolveWithinRoot(this.workingDir, dirPath);
    // -1 每行一个，-A 含隐藏（除 . ..），-p 目录加尾斜杠。
    const res = await this.exec(`ls -1Ap ${JSON.stringify(abs)}`);
    if (res.exitCode !== 0) {
      throw new Error(`readdir failed for ${dirPath}: ${res.stderr.trim()}`);
    }
    return res.stdout
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l !== "")
      .map((l) =>
        l.endsWith("/")
          ? { name: l.slice(0, -1), type: "dir" as const }
          : { name: l, type: "file" as const },
      );
  }

  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const ac = new AbortController();
    const signal = opts?.signal
      ? AbortSignal.any([opts.signal, ac.signal])
      : ac.signal;
    const timer = setTimeout(
      () => ac.abort(new Error(`timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
    try {
      const res = await this.sdk.runCommand({
        cmd: "sh",
        args: ["-c", command],
        cwd: this.workingDir,
        signal,
      });
      const out = truncate(await res.stdout());
      const err = truncate(await res.stderr());
      return {
        exitCode: res.exitCode,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
      };
    } catch (e) {
      if (ac.signal.aborted) {
        throw new SandboxTimeoutError(`command timed out after ${timeoutMs}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async snapshot(): Promise<{ snapshotId: string }> {
    const snap = await this.sdk.snapshot();
    this.state.snapshotId = snap.snapshotId;
    return { snapshotId: snap.snapshotId };
  }

  async stop(): Promise<void> {
    await this.sdk.stop();
  }

  getState(): SandboxState {
    return { ...this.state };
  }
}

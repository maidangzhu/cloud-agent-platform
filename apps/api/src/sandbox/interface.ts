// 统一 Sandbox 接口 —— 上层工具只依赖它，不直接碰 @vercel/sandbox SDK。
// P0 唯一实现 VercelSandbox（见 vercel-sandbox.ts）；接口保留以便未来接别的隔离后端。
// 路径越权防护（path-guard）与命令超时/输出截断在实现层统一施加。

export interface DirEntry {
  name: string;
  type: "file" | "dir";
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** stdout/stderr 是否因超长被截断 */
  truncated: boolean;
}

export interface ExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 落库用的沙箱状态引用（不含文件系统本身）。对应 Workspace 表字段。 */
export interface SandboxState {
  provider: string;
  sandboxName?: string;
  snapshotId?: string;
}

export interface Sandbox {
  /** 工作目录（所有相对路径相对于它解析并约束在内）。 */
  readonly workingDir: string;

  /** 读文件（workspace 内相对/绝对路径；越权抛错；不存在抛错）。 */
  readFile(path: string): Promise<string>;

  /** 写文件（必要时创建父目录；越权抛错）。 */
  writeFile(path: string, content: string): Promise<void>;

  /** 列目录（越权抛错）。 */
  readdir(path: string): Promise<DirEntry[]>;

  /** 执行命令（已由调用方过 policy）；带超时与输出截断。 */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;

  /** 文件系统快照（② 快照恢复）；会停止沙箱。 */
  snapshot(): Promise<{ snapshotId: string }>;

  /** 停止当前会话（persistent 沙箱会在停止时快照文件系统）。 */
  stop(): Promise<void>;

  /** 返回落库用的状态引用。 */
  getState(): SandboxState;
}

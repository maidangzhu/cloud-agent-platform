import { Type } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Sandbox } from "../sandbox/interface";
import { resolveWithinRoot } from "../sandbox/path-guard";
import { evaluateCommand } from "./policy";

// 5 个受控工具：list_files / read_file / search_text / write_file / run_command。
// 每个工具用 TypeBox 声明入参（Pi 要求），sandbox 经闭包绑定（createTools）。
// 约定：失败即 throw —— Pi 的 agent loop 会把抛出的错误转成 error tool-result 喂回
// 模型（可恢复小错如文件不存在也走这条）。路径越权由 path-guard 在 sandbox 层拦截；
// run_command 额外内置命令 policy 检查。

/** 工具执行上下文：绑定到某个 Run 的 sandbox。 */
export interface ToolContext {
  sandbox: Sandbox;
}

/** run_command 命中高风险/非白名单时抛出，供上层映射为 ToolCall rejected。 */
export class ToolRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRejectedError";
  }
}

function textResult(
  text: string,
  details: unknown = {},
): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

/** sh 单引号转义，避免把模型给的字符串拼进 shell 时被解释。 */
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// 用一个 helper 保留 execute 内 params 的类型，同时产出 Pi 的 AgentTool。
function defineTool<T extends TSchema>(def: {
  name: string;
  label: string;
  description: string;
  parameters: T;
  execute: (
    params: Static<T>,
    signal?: AbortSignal,
  ) => Promise<AgentToolResult<unknown>>;
}): AgentTool {
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    execute: (_id, params, signal) => def.execute(params as Static<T>, signal),
  } as AgentTool;
}

/** 构造绑定到某 sandbox 的 5 个工具，供 Pi Agent 使用。 */
export function createTools(ctx: ToolContext): AgentTool[] {
  const { sandbox } = ctx;

  const listFiles = defineTool({
    name: "list_files",
    label: "List files",
    description: "列出 workspace 内某目录的文件与子目录（目录名带尾斜杠）。",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: "相对 workspace 的目录，默认根目录 '.'" }),
      ),
    }),
    async execute(params) {
      const dir = params.path ?? ".";
      const entries = await sandbox.readdir(dir);
      const text =
        entries
          .map((e) => (e.type === "dir" ? `${e.name}/` : e.name))
          .join("\n") || "(empty)";
      return textResult(text, { entries });
    },
  });

  const readFile = defineTool({
    name: "read_file",
    label: "Read file",
    description: "读取 workspace 内一个文件的全部文本内容。",
    parameters: Type.Object({
      path: Type.String({ description: "相对 workspace 的文件路径" }),
    }),
    async execute(params) {
      const content = await sandbox.readFile(params.path);
      return textResult(content, { path: params.path, bytes: content.length });
    },
  });

  const searchText = defineTool({
    name: "search_text",
    label: "Search text",
    description:
      "在 workspace 内按固定字符串全文搜索（用于找 TODO/FIXME 等），返回 file:line:内容。",
    parameters: Type.Object({
      query: Type.String({ description: "要搜索的固定字符串" }),
      path: Type.Optional(
        Type.String({ description: "搜索目录，默认 workspace 根 '.'" }),
      ),
    }),
    async execute(params) {
      const dir = params.path ?? ".";
      const absDir = resolveWithinRoot(sandbox.workingDir, dir);
      // -r 递归，-n 行号，-I 跳过二进制，-F 固定字符串。
      const res = await sandbox.exec(
        `grep -rnIF -e ${shq(params.query)} -- ${shq(absDir)}`,
      );
      // grep 退出码：0=有匹配，1=无匹配，>1=出错。
      if (res.exitCode > 1) {
        throw new Error(`search_text failed: ${res.stderr.trim()}`);
      }
      const prefix = sandbox.workingDir.endsWith("/")
        ? sandbox.workingDir
        : `${sandbox.workingDir}/`;
      const matches = res.stdout
        .split("\n")
        .filter((l) => l !== "")
        .map((line) => {
          const m = /^(.*?):(\d+):(.*)$/.exec(line);
          if (!m) return null;
          const file = m[1].startsWith(prefix) ? m[1].slice(prefix.length) : m[1];
          return { file, line: Number(m[2]), text: m[3] };
        })
        .filter((x): x is { file: string; line: number; text: string } => x !== null);
      const text = matches.length
        ? matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n")
        : "(no matches)";
      return textResult(text, { matches, count: matches.length });
    },
  });

  const writeFile = defineTool({
    name: "write_file",
    label: "Write file",
    description: "向 workspace 内写入一个文件（覆盖；自动创建父目录）。",
    parameters: Type.Object({
      path: Type.String({ description: "相对 workspace 的文件路径" }),
      content: Type.String({ description: "文件内容" }),
    }),
    async execute(params) {
      await sandbox.writeFile(params.path, params.content);
      const bytes = Buffer.byteLength(params.content, "utf8");
      return textResult(`Wrote ${bytes} bytes to ${params.path}`, {
        path: params.path,
        bytes,
      });
    },
  });

  const runCommand = defineTool({
    name: "run_command",
    label: "Run command",
    description:
      "在 workspace 内执行一条只读检视类 shell 命令（白名单：grep/cat/ls/find 等；高风险命令会被拒绝）。",
    parameters: Type.Object({
      command: Type.String({ description: "要执行的命令" }),
      timeoutMs: Type.Optional(
        Type.Number({ description: "超时毫秒，默认 30s" }),
      ),
    }),
    async execute(params, signal) {
      const decision = evaluateCommand(params.command);
      if (!decision.allowed) {
        throw new ToolRejectedError(
          decision.reason ?? "command rejected by policy",
        );
      }
      const res = await sandbox.exec(params.command, {
        timeoutMs: params.timeoutMs,
        signal,
      });
      const text = [
        `exit ${res.exitCode}`,
        res.stdout && `--- stdout ---\n${res.stdout}`,
        res.stderr && `--- stderr ---\n${res.stderr}`,
      ]
        .filter(Boolean)
        .join("\n");
      return textResult(text, {
        exitCode: res.exitCode,
        truncated: res.truncated,
      });
    },
  });

  return [listFiles, readFile, searchText, writeFile, runCommand];
}

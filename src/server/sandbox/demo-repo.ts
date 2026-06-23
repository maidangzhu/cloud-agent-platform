// 中性 demo 仓库 fixture —— 沙箱首次初始化时 seed 进 workspace。
// 用于 demo 任务「读仓库找 TODO 生成报告」。
// 约束：零 PII（无人名/公司/个人路径），内容中立；故意撒 TODO/FIXME 供 search_text 命中。

export const DEMO_REPO_FILES: Record<string, string> = {
  "README.md": `# Task Tracker (demo)

一个极简任务管理示例项目，用于演示 Cloud Agent Platform 的代码检视能力。

## 结构
- \`src/index.ts\` 入口
- \`src/store.ts\` 内存存储
- \`src/api.ts\` 路由处理
- \`src/utils.ts\` 工具函数
`,

  "package.json": `{
  "name": "task-tracker-demo",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "start": "node src/index.js"
  }
}
`,

  "src/index.ts": `import { createStore } from "./store";
import { handleRequest } from "./api";

// TODO: 从环境变量读取端口，目前硬编码
const PORT = 3000;

const store = createStore();

function main() {
  // TODO: 接入真实 HTTP server，这里只是占位
  console.log("task-tracker listening on", PORT);
  handleRequest(store, { method: "GET", path: "/tasks" });
}

main();
`,

  "src/store.ts": `export interface Task {
  id: string;
  title: string;
  done: boolean;
}

// FIXME: 内存存储重启即丢，后续换持久化
const tasks: Task[] = [];

export function createStore() {
  return {
    list: () => tasks,
    // TODO: 加入按 done 过滤的能力
    add: (title: string) => {
      const task: Task = { id: String(tasks.length + 1), title, done: false };
      tasks.push(task);
      return task;
    },
  };
}
`,

  "src/api.ts": `import type { Task } from "./store";

interface Req {
  method: string;
  path: string;
}

// TODO: 补充错误处理与输入校验
export function handleRequest(
  store: { list: () => Task[] },
  req: Req,
): Task[] | null {
  if (req.method === "GET" && req.path === "/tasks") {
    return store.list();
  }
  // FIXME: 未匹配路由应返回 404，目前返回 null
  return null;
}
`,

  "src/utils.ts": `// 工具函数集合

export function slugify(input: string): string {
  // TODO: 处理 Unicode，目前只支持 ASCII
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export function formatDate(d: Date): string {
  // FIXME: 时区写死为 UTC，应支持本地时区
  return d.toISOString().slice(0, 10);
}
`,

  "docs/notes.md": `# 开发笔记

- TODO: 补单元测试
- TODO: 评估替换内存存储为 SQLite
- 已知问题见各文件 FIXME 标记
`,
};

/** demo-repo 已 seed 的标记文件（factory 据此判断「新建则 seed、复用则跳过」）。 */
export const DEMO_REPO_SEED_MARKER = ".cap-seeded";

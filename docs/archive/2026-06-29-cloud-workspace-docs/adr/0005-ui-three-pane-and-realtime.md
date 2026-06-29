# ADR-0005：UI 三栏布局 + 实时同步

- 状态：已采纳
- 日期：2026-06-28
- 依赖：ADR-0001, ADR-0002, ADR-0004
- 关键词：UI layout、SSE、realtime sync、optimistic UI

## 背景

用户要的是"Notion + Claude"那种体验：

- 左侧像 Notion：层级目录、文件树、点击切换
- 中间像 IDE：当前文件的 preview / 编辑
- 右侧像 Chat：用户提问、看 agent 进度、看结果

**核心交互矛盾**：

- 用户改文件 / agent 改文件 都要让对方实时看到
- 网络可能断
- 多人同时改可能冲突
- agent 在跑的时候 UI 要显示进度

## 决定

### 布局

```
┌──────────────────────────────────────────────────────────────────────┐
│ TopBar: workspace 名 │ members │ run status │ user menu               │
├───────────────┬──────────────────────────┬───────────────────────────┤
│ FileTree      │ Preview / Editor         │ Chat                      │
│ (左 240px)    │ (中 flex)                │ (右 400px)                │
│               │                          │                           │
│ 📁 workspace/ │ diary.md (只读 render)   │ User: 帮我加一行          │
│  ├─ README.md │ ─────────────────────    │                           │
│  ├─ notes/    │ deployed PoC 2026-06-28  │ Assistant:                │
│  │  └─ today  │ second run ok            │  ✓ read_file              │
│  └─ diary.md⭐│                          │  ✓ write_file             │
│               │                          │  已写入。                  │
│  + New file   │                          │                           │
│               │                          │ [send prompt]             │
└───────────────┴──────────────────────────┴───────────────────────────┘
```

### 数据流：3 个独立数据流

```
左栏 FileTree：
  GET  /api/workspace/:id/files              ← 初次加载
  WS   /api/workspace/:id/events?type=file.* ← 增量推送
  → client 维护 tree state，事件来时 patch

中栏 Preview：
  GET  /api/workspace/:id/files/:path        ← 打开文件
  → 缓存按 path，乐观更新
  → 收到 file.modified event 时 invalidate + refetch

右栏 Chat：
  POST /api/workspace/:id/runs               ← 启动 run
  SSE  /api/runs/:id/stream                  ← 实时 event 流
  → 事件来时 append 到 message list
  → 工具调用状态内联显示
```

**3 个数据流独立订阅**，互不阻塞。

### 实时同步通道

**只用 SSE**（不用 WebSocket）：

- 浏览器原生 EventSource，自动重连
- 单向（server → client）够用
- 走 HTTP/HTTPS，CDN/反代友好
- WebSocket 留给 sandbox ↔ control plane（双向、需要 stream）

```
control plane SSE handler:
  client.connect(workspace_id)
  loop:
    event = await event_queue.pop()  # Redis pub/sub 或 Postgres LISTEN
    if event.workspace_id == client.workspace_id:
      sse.send({ event: event.type, data: json })
```

### 事件订阅粒度

客户端订阅 3 种过滤：

| 过滤 | 端点 | 用途 |
|---|---|---|
| workspace 全部 | `/api/workspace/:id/events` | 左栏 file tree |
| 单 run 详细 | `/api/runs/:id/stream` | 右栏 chat |
| user 通知 | `/api/users/:id/notifications` | proposal 审批、mention |

### 乐观更新（Optimistic UI）

用户在中间栏编辑文件时：

```
User 在 editor 里键入
  → 本地 state 立刻更新（不等 server）
  → 防抖 500ms 后 PUT 到 server
  → server 写 WorkspaceFile（带 ETag）
  → 如果 ETag 不匹配（别人同时改） → 409 conflict → UI 显示 diff
```

agent 改文件时也走 server，所以用户编辑器能立刻收到 `file.modified` event 触发刷新。

### 多用户冲突

同文件多人同时编辑：

- 用 `EditCheckpoint`（archived ADR-0002 设计）+ ETag
- 冲突时 UI 显示 3-way diff：本机 / 远端 / base
- 用户手动 merge 后再 PUT
- **不做自动 merge**（agent 写的代码不能 auto-merge 出错）

### Run 状态可视化

Chat 栏里 agent 进度：

```
User    13:20  帮我把 diary.md 加一行
─────────────────────────────────
Agent   13:20  ✓ 读取 diary.md (234ms)
        13:21  ⟳ 思考中...
        13:22  ⟳ 写入 diary.md
        13:22  ✓ 完成
        13:22  "已追加 second run ok"
─────────────────────────────────
[input: 继续输入...]
```

工具调用状态内联、thinking 用"思考中"占位、完成用勾。

### 客户端状态管理

- **React Query**（TanStack Query）：服务器态（files、runs 列表）
- **Zustand**：本地 UI 态（当前选中文件、editor 草稿、run 进度）
- **不用 Redux / MobX**（太重）

代码组织：

```
src/app/workspace/[workspaceId]/
  page.tsx                          ← 三栏 layout
  _components/
    FileTree/                       ← 左栏
    FilePreview/                    ← 中栏
    Chat/                           ← 右栏
    TopBar/
  _hooks/
    useWorkspaceEvents.ts           ← SSE 订阅
    useRunStream.ts                 ← run event SSE
    useFileTree.ts                  ← 文件树 + 实时刷新
```

## 不做什么

- ❌ 不做"WebSocket 双向实时"（SSE 够用 + 更简单）
- ❌ 不做"自动 merge 冲突"（用户手动）
- ❌ 不做"实时协作光标"（P1，不是 P0）
- ❌ 不做"完整富文本编辑器"（markdown preview / code 编辑先用 Monaco，P1 再加 ProseMirror/Tiptap）


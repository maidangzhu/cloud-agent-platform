# ADR-0003：Workspace Sandbox 生命周期（Warm Pool / Freeze / Thaw）

- 状态：已采纳
- 日期：2026-06-28
- 依赖：ADR-0001, ADR-0002
- 关键词：sandbox lifecycle、warm pool、OSS snapshot、freeze/thaw

## 背景

Vercel microVM 跑一个 sandbox 约 50s 冷启动（npm install + daemon 起来），持续运行按秒计费。

对用户体验：
- 第一次 run 30s 等 sandbox 起来，可接受
- 第二次 run 又 30s，**不可接受**

对成本：
- 用户停止操作 5 分钟，sandbox 还活着继续扣费

**问题**：怎么平衡"低延迟" vs "低成本"？

## 决定

### Sandbox 状态机

```
              create
                │
                ▼
        ┌──────────────┐
        │ provisioning │
        └──────┬───────┘
               │ health ok
               ▼
        ┌──────────────┐  5min 无活动
        │    warm      │ ───────────┐
        └──────┬───────┘            │
               │  run 完成 +        ▼
               │  5min idle   ┌──────────────┐
               │              │  freezing    │
               │              └──────┬───────┘
               │                     │ tar → OSS
               │                     ▼
               │              ┌──────────────┐
               │              │   frozen     │
               │              └──────┬───────┘
               │                     │ 下一个 run 触发
               │                     ▼
               │              ┌──────────────┐
               │              │   thawing    │
               │              └──────┬───────┘
               │                     │ 解压 + 起 daemon
               │                     ▼
               │              ┌──────────────┐
               └─────────────→│    warm      │ (acquire)
                              └──────────────┘
```

### 表结构

```sql
CREATE TABLE workspace_sandboxes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,           -- "vercel" | "local"
  provider_handle TEXT,             -- sandbox name（Vercel SDK 用）
  base_url TEXT,
  status TEXT NOT NULL,             -- provisioning|warm|freezing|frozen|thawing|dead
  last_activity_at TIMESTAMPTZ,
  warm_snapshot_url TEXT,           -- OSS key
  outbox_offset INTEGER DEFAULT 0,  -- 最后同步到 control plane 的 seq
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  UNIQUE(workspace_id, provider)
);

CREATE INDEX ON workspace_sandboxes (status, last_activity_at);
```

### 获取 sandbox 流程

```python
def get_or_create_sandbox(workspace_id: str) -> SandboxHandle:
    row = SELECT * FROM workspace_sandboxes
          WHERE workspace_id=? AND provider='vercel'

    if row and row.status in ('warm',):
        row.last_activity_at = now()
        return SandboxHandle(row)

    if row and row.status == 'provisioning':
        return wait_for_provisioning(row, timeout=120s)

    if row and row.status == 'freezing':
        # 抢锁：cancel freeze 改回 warm
        # 简单做法：等它完成 frozen 再 thaw
        wait_for_state(row, 'frozen', timeout=30s)
        return thaw(row)

    if row and row.status == 'frozen':
        return thaw(row)               # 拉 OSS → 起 daemon → 改 warm

    if row and row.status == 'thawing':
        return wait_for_state(row, 'warm', timeout=60s)

    if not row:
        return provision_new(workspace_id)
```

### Freeze 流程

```python
async def freeze_sandbox(workspace_id: str):
    row = SELECT * WHERE workspace_id=? AND status='warm' FOR UPDATE
    row.status = 'freezing'
    UPDATE ...

    # 1. 停 agent 进程（优雅：发 SIGTERM，等 5s，SIGKILL）
    sandbox.exec("pkill -TERM -f agent-daemon || true")
    sleep 5

    # 2. 触发 outbox flush
    forwarder.flush_all()              # 同步等所有 outbox 事件 ack
    # 此时 outbox_offset == max_seq

    # 3. 落 forwarder 状态
    sandbox.exec("sqlite3 outbox.sqlite 'PRAGMA wal_checkpoint(TRUNCATE)'")

    # 4. 打包 /workspace + .agent + .skills + .memory
    tar = sandbox.exec("tar czf /tmp/snapshot.tar.gz /workspace .agent .skills .memory")
    #   ⚠️ 不要把 .agent/outbox.sqlite 排除，因为它是 sandbox 的事实源

    # 5. 上传 OSS
    snapshot_url = oss.upload(tar, key=f"workspaces/{workspace_id}/snapshots/{ts}.tar.gz")

    # 6. 落库
    row.warm_snapshot_url = snapshot_url
    row.status = 'frozen'
    row.outbox_offset = forwarder.last_acked_seq
    UPDATE ...

    # 7. 停 sandbox
    sandbox.stop()
```

### Thaw 流程

```python
async def thaw_sandbox(workspace_id: str, snapshot_url: str):
    row = SELECT ... FOR UPDATE
    row.status = 'thawing'
    UPDATE ...

    # 1. 起新 sandbox（Vercel SDK getOrCreate，名字稳定）
    new = vercel.create(name=f"ws-{workspace_id}", runtime="node24")

    # 2. 拉 OSS snapshot
    tar = oss.download(snapshot_url)
    new.exec(f"mkdir -p /workspace && tar xzf {tar.path} -C /")

    # 3. 起 daemon + forwarder
    new.exec("nohup node /workspace/.agent/daemon.cjs > /tmp/daemon.log 2>&1 &")
    wait_for_health(new.base_url, 30s)

    # 4. forwarder 从 outbox_offset+1 续传
    new.exec(f"FORWARDER_OFFSET={row.outbox_offset} agent-forwarder &")

    # 5. 落库
    row.provider_handle = new.handle
    row.base_url = new.url
    row.status = 'warm'
    row.last_activity_at = now()
    UPDATE ...
```

### Warm Pool（可选优化）

冷启动 50s 还是太慢。**预热 N 个 sandbox** 待用：

```
background job:
  maintain_pool_size(5)
  for each missing:
    sandbox = vercel.create(name=pre-warm-{i}, runtime=node24)
    install daemon
    sandbox.standby()
    pool.add(sandbox)

acquire(workspace_id):
  if pool: take one, bind to workspace_id (rename + register)
  else: provision_new
```

Vercel microVM 不支持"暂停后恢复"（必须 stop + start），所以 warm pool 的实际收益是省下 npm install + 第一次 daemon 启动（~30s），不能省 microVM 拉起时间。

**P0 不做**，P1 再说。

### Provider 抽象

```typescript
// src/server/sandbox/provider.ts
export interface SandboxProvider {
  name: "vercel" | "local" | "e2b";
  create(opts: { name: string; runtime: string; ports: number[] }): Promise<{ handle: string; domain: (port: number) => string; runCommand: (...) => ...; stop: () => Promise<void>; writeFiles: (...) => ... }>;
  resume(handle: string): Promise<...>;  // 重连到已存在的 sandbox
  isAlive(handle: string): Promise<boolean>;
}

class VercelSandboxProvider implements SandboxProvider { ... }
class LocalSandboxProvider implements SandboxProvider { ... }   // dev/test
class E2BProvider implements SandboxProvider { ... }             // future
```

`sandbox handle` 用 stable name（`ws-{workspace_id}`），Vercel `getOrCreate` 复用已有。

### OSS 选型

| 需求 | 推荐 |
|---|---|
| 简单 + S3 兼容 | Cloudflare R2 / AWS S3 / 阿里 OSS |
| snapshot 体积 | 通常 < 100MB（workspace + .agent），tar.gz 后 < 30MB |
| 加密 | SSE-KMS（snapshot 含用户工作内容） |
| 生命周期 | 90 天后删 cold snapshot（如果 workspace 活跃会自动重写） |

**P0 起步**：直接用 S3 兼容 API + 服务端加密。`warm_snapshot_url` 是签名 URL，有效期 1 小时。

## 不做什么

- ❌ 不做"sandbox 永久运行"（成本不可接受）
- ❌ 不做"sandbox 自动迁移"（Vercel SDK 不支持）
- ❌ 不做"实时文件跨 sandbox 同步"（freeze/thaw 已经够）
- ❌ 不把 OSS 凭证下发到 sandbox（sandbox 通过 control plane 间接下载）
- ❌ P0 不做 warm pool（先验证 freeze/thaw 流程）


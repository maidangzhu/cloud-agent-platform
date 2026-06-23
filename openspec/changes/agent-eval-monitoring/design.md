# Design — Agent Eval & Monitoring System

## 架构

```
scripts/eval/
├── shared/
│   ├── db.ts              # 数据库连接与查询辅助函数
│   ├── time-range.ts      # 时间范围解析（--from/--to）
│   └── formatters.ts      # JSON/Text 格式化输出
├── run-metrics.ts         # Run 级别指标统计
├── tool-metrics.ts        # 工具调用指标统计
└── detect-stuck-runs.ts   # 异常 Run 检测
```

package.json 新增脚本：
```json
{
  "scripts": {
    "eval:runs": "tsx scripts/eval/run-metrics.ts",
    "eval:tools": "tsx scripts/eval/tool-metrics.ts",
    "eval:detect-stuck": "tsx scripts/eval/detect-stuck-runs.ts"
  }
}
```

## 数据模型（已有，无需修改）

```prisma
model Run {
  id          String   @id
  sessionId   String
  status      String   // created/provisioning_workspace/running/completed/failed/timeout/cancelled
  createdAt   DateTime
  completedAt DateTime?
  error       String?
  events      AgentEvent[]
  toolCalls   ToolCall[]
}

model AgentEvent {
  id        String   @id
  runId     String
  seq       Int
  type      String   // run_created/workspace_ready/agent_started/tool_call_started/tool_call_completed/model_step/artifact_created/run_completed/run_failed
  createdAt DateTime
  payload   Json?
}

model ToolCall {
  id        String   @id
  runId     String
  name      String   // run_command/read_file/write_file/list_files/search_text
  status    String   // pending/completed/failed/rejected
  createdAt DateTime
  updatedAt DateTime
}
```

## 核心查询

### 1. Run 指标查询

```typescript
// 获取时间范围内的所有 Run
const runs = await prisma.run.findMany({
  where: {
    createdAt: { gte: from, lte: to }
  },
  select: {
    id: true,
    status: true,
    createdAt: true,
    completedAt: true,
    error: true,
  }
});

// 计算指标
const totalRuns = runs.length;
const statusBreakdown = groupBy(runs, 'status');
const durations = runs
  .filter(r => r.completedAt)
  .map(r => (r.completedAt.getTime() - r.createdAt.getTime()) / 1000);

const metrics = {
  totalRuns,
  statusBreakdown,
  completionRate: statusBreakdown.completed / totalRuns,
  avgDuration: mean(durations),
  p50Duration: percentile(durations, 50),
  p95Duration: percentile(durations, 95),
  p99Duration: percentile(durations, 99),
};
```

### 2. 工具调用指标查询

```typescript
// 获取时间范围内的所有工具调用
const toolCalls = await prisma.toolCall.findMany({
  where: {
    createdAt: { gte: from, lte: to }
  },
  select: {
    name: true,
    status: true,
    createdAt: true,
    updatedAt: true,
  }
});

// 按工具名称分组统计
const toolBreakdown = groupBy(toolCalls, 'name').map(group => ({
  tool: group.name,
  calls: group.items.length,
  success: group.items.filter(t => t.status === 'completed').length,
  failed: group.items.filter(t => t.status === 'failed').length,
  rejected: group.items.filter(t => t.status === 'rejected').length,
  avgDuration: mean(group.items.map(t => 
    (t.updatedAt.getTime() - t.createdAt.getTime()) / 1000
  ))
}));

const metrics = {
  totalToolCalls: toolCalls.length,
  successRate: toolCalls.filter(t => t.status === 'completed').length / toolCalls.length,
  toolBreakdown,
};
```

### 3. 卡住 Run 检测

```typescript
// 查找状态为 running 且超过阈值时间无更新的 Run
const STUCK_THRESHOLD = 10 * 60; // 10 分钟

const runningRuns = await prisma.run.findMany({
  where: {
    status: { in: ['running', 'provisioning_workspace'] },
    createdAt: { lt: new Date(Date.now() - STUCK_THRESHOLD * 1000) }
  },
  include: {
    events: {
      orderBy: { seq: 'desc' },
      take: 1,
    }
  }
});

const stuckRuns = runningRuns
  .filter(run => {
    const lastEvent = run.events[0];
    if (!lastEvent) return true; // 无事件肯定卡了
    
    const timeSinceLastEvent = (Date.now() - lastEvent.createdAt.getTime()) / 1000;
    return timeSinceLastEvent > STUCK_THRESHOLD;
  })
  .map(run => {
    const lastEvent = run.events[0];
    const stuckDuration = lastEvent 
      ? (Date.now() - lastEvent.createdAt.getTime()) / 1000
      : (Date.now() - run.createdAt.getTime()) / 1000;
    
    return {
      runId: run.id,
      sessionId: run.sessionId,
      status: run.status,
      createdAt: run.createdAt,
      lastEventAt: lastEvent?.createdAt,
      lastEventType: lastEvent?.type,
      stuckDuration,
      diagnosis: diagnoseSuspect(run, lastEvent),
    };
  });
```

### 4. 慢 Run 检测

```typescript
// 找出耗时超过 p95 的 Run
const slowRuns = runs
  .filter(r => r.completedAt)
  .map(r => ({
    runId: r.id,
    duration: (r.completedAt.getTime() - r.createdAt.getTime()) / 1000,
  }))
  .filter(r => r.duration > p95Duration)
  .sort((a, b) => b.duration - a.duration)
  .slice(0, 10); // Top 10 最慢的

const result = slowRuns.map(r => ({
  ...r,
  p95Duration,
  ratio: r.duration / p95Duration,
  diagnosis: r.duration > p95Duration * 3 ? '异常慢（超过 p95 3倍）' : '较慢',
}));
```

## 诊断逻辑

### 卡住原因诊断

```typescript
function diagnoseSuspect(run: Run, lastEvent?: AgentEvent): string {
  if (!lastEvent) {
    return '创建 Run 后无任何事件，可能 workspace 启动失败';
  }

  switch (lastEvent.type) {
    case 'workspace_provisioning':
      return 'Workspace 启动中卡住，可能 Vercel Sandbox 问题或凭据无效';
    
    case 'agent_started':
      return 'Agent 启动后无后续动作，可能初始 LLM 请求超时';
    
    case 'tool_call_started':
      return '工具调用启动后无响应，可能沙箱执行卡住或 LLM 等待超时';
    
    case 'model_step':
      return 'LLM 响应后无后续事件，可能事件落库失败或 agent loop 异常退出';
    
    default:
      return `最后事件为 ${lastEvent.type}，原因不明`;
  }
}
```

## 输出格式

### JSON 格式（机器可读）

```typescript
interface RunMetricsReport {
  timeRange: { from: string; to: string };
  totalRuns: number;
  statusBreakdown: Record<string, number>;
  completionRate: number;
  avgDuration: number;
  p50Duration: number;
  p95Duration: number;
  p99Duration: number;
}
```

### Text 格式（人类可读）

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Run Metrics Report
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Time Range: 2026-06-23 00:00:00 → 2026-06-23 23:59:59

📊 Overview
  Total Runs:       42
  Completion Rate:  83.3% (35/42)
  Avg Duration:     64.5s

📈 Status Breakdown
  ✅ completed:     35 (83.3%)
  ❌ failed:        3  (7.1%)
  ⏱️  timeout:      2  (4.8%)
  🚫 cancelled:     1  (2.4%)
  🔄 running:       1  (2.4%)

⏱️  Duration Percentiles
  p50:  58s
  p95:  120s
  p99:  180s
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## CLI 参数

所有脚本统一支持：

```bash
# 时间范围（默认：过去 24 小时）
--from "2026-06-23T00:00:00Z"
--to "2026-06-23T23:59:59Z"

# 输出格式（默认：text）
--format json|text

# 示例
pnpm eval:runs --from "2026-06-23T00:00:00Z" --to "2026-06-23T23:59:59Z" --format json
pnpm eval:detect-stuck --format text
```

## 工具函数库

### shared/time-range.ts

```typescript
export interface TimeRange {
  from: Date;
  to: Date;
}

export function parseTimeRange(args: {
  from?: string;
  to?: string;
}): TimeRange {
  const to = args.to ? new Date(args.to) : new Date();
  const from = args.from 
    ? new Date(args.from) 
    : new Date(to.getTime() - 24 * 60 * 60 * 1000); // 默认过去 24h
  
  return { from, to };
}
```

### shared/formatters.ts

```typescript
export type OutputFormat = 'json' | 'text';

export function formatReport(data: any, format: OutputFormat): string {
  if (format === 'json') {
    return JSON.stringify(data, null, 2);
  }
  
  // text 格式：人类可读的表格/列表
  return formatAsText(data);
}

function formatAsText(data: any): string {
  // 实现文本格式化逻辑
}
```

### shared/stats.ts

```typescript
export function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[index];
}

export function groupBy<T>(items: T[], key: keyof T): Record<string, T[]> {
  return items.reduce((acc, item) => {
    const group = String(item[key]);
    acc[group] = acc[group] || [];
    acc[group].push(item);
    return acc;
  }, {} as Record<string, T[]>);
}
```

## 测试策略

### 单元测试（纯函数）

- `time-range.ts` 解析逻辑
- `stats.ts` 统计函数（mean, percentile, groupBy）
- `formatters.ts` 格式化输出

### 集成测试（连真实数据库）

- 创建测试 Run 数据 → 运行脚本 → 验证输出指标
- 创建"卡住"场景 → 运行检测 → 验证诊断结果

## 演进路线

### P0（当前）

- ✅ Run 指标统计
- ✅ 工具调用指标统计
- ✅ 卡住 Run 检测

### P1（后续）

- [ ] Benchmark 测试套件
- [ ] 性能回归检测
- [ ] 自动化报告生成（定时任务）
- [ ] 告警集成（Slack/Email）

### P2（未来）

- [ ] 指标可视化（Grafana/Dashboard）
- [ ] 实时监控（WebSocket 推送）
- [ ] 用户行为分析

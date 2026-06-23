# Proposal — Agent Eval & Monitoring System

## 背景

当前平台已完成 MVP 核心功能，但缺乏对 Agent 执行质量和系统健康度的量化评估。线上出现了"Run 执行到一半卡住、SSE 不再输出也不结束"的问题，需要：

1. **Eval 指标体系** — 量化 Agent 执行质量（成功率、耗时、工具调用效率）
2. **异常检测** — 识别卡住、超时、失败的 Run，诊断根因
3. **Benchmark 测试** — 可重复的测试用例，跟踪性能回归

## 目标

### P0：核心 Eval 指标与监控

1. **Run 级别指标**
   - 完成率（completed / total）
   - 平均耗时（从创建到完成）
   - 超时率（timeout / total）
   - 失败率（failed / total）

2. **工具调用指标**
   - 工具调用成功率
   - 每个 Run 的平均工具调用次数
   - 工具调用平均耗时

3. **异常检测**
   - 识别"卡住"的 Run（状态为 running 但超过 N 分钟无事件更新）
   - 识别频繁失败的工具调用
   - 识别异常慢的 LLM 请求

### P1：Benchmark 测试套件（后续）

- 标准测试用例（简单任务、复杂任务、多轮对话）
- 自动化运行 + 结果对比
- 性能回归检测

## 非目标

- ❌ 不做实时告警（P0 只做离线分析）
- ❌ 不做用户行为分析
- ❌ 不做计费相关指标

## 方案概览

### 1. 数据收集（已有）

现有数据足够支撑 P0 指标：
- `Run` 表：status, createdAt, completedAt, error
- `AgentEvent` 表：type, seq, createdAt, payload
- `ToolCall` 表：status, createdAt, updatedAt

### 2. 分析脚本

创建独立的分析脚本（不影响生产代码）：

```
scripts/
  eval/
    run-metrics.ts        # Run 级别指标统计
    tool-metrics.ts       # 工具调用指标统计
    detect-stuck-runs.ts  # 检测卡住的 Run
    benchmark.ts          # Benchmark 测试执行器（P1）
```

### 3. 输出格式

#### 3.1 Run 指标报告

```typescript
{
  timeRange: { from: "2026-06-23T00:00:00Z", to: "2026-06-23T23:59:59Z" },
  totalRuns: 42,
  statusBreakdown: {
    completed: 35,
    failed: 3,
    timeout: 2,
    cancelled: 1,
    running: 1
  },
  completionRate: 0.833,  // 35/42
  avgDuration: 64.5,      // 秒
  p50Duration: 58,
  p95Duration: 120,
  p99Duration: 180
}
```

#### 3.2 工具调用指标

```typescript
{
  totalToolCalls: 156,
  successRate: 0.942,
  toolBreakdown: {
    run_command: { calls: 89, success: 85, avgDuration: 2.3 },
    read_file: { calls: 45, success: 45, avgDuration: 0.8 },
    write_file: { calls: 12, success: 11, avgDuration: 1.1 },
    list_files: { calls: 8, success: 8, avgDuration: 0.5 },
    search_text: { calls: 2, success: 2, avgDuration: 1.8 }
  }
}
```

#### 3.3 异常 Run 检测

```typescript
{
  stuckRuns: [
    {
      runId: "abc123",
      sessionId: "sess456",
      status: "running",
      createdAt: "2026-06-23T10:00:00Z",
      lastEventAt: "2026-06-23T10:05:00Z",
      stuckDuration: 3600,  // 秒
      lastEventType: "tool_call_started",
      diagnosis: "工具调用启动后无后续事件，可能 LLM 响应超时或沙箱卡住"
    }
  ],
  slowRuns: [
    {
      runId: "def789",
      duration: 450,
      p95Duration: 120,
      diagnosis: "耗时 450s，超过 p95（120s）3.75倍"
    }
  ]
}
```

## 验收标准

### P0

- [ ] `pnpm eval:runs` — 输出 Run 级别指标报告（JSON + 人类可读）
- [ ] `pnpm eval:tools` — 输出工具调用指标报告
- [ ] `pnpm eval:detect-stuck` — 检测并输出异常 Run 列表
- [ ] 所有脚本支持 `--from` / `--to` 参数指定时间范围
- [ ] 所有脚本支持 `--format json|text` 控制输出格式

### P1（后续）

- [ ] `pnpm benchmark` — 运行标准测试用例并生成报告
- [ ] 测试用例覆盖：简单任务、复杂任务、多轮对话、错误恢复
- [ ] Benchmark 结果对比（与历史基线）

## 时间估算

- **P0 核心指标与监控**：1-2 天
  - Run 指标脚本：0.5 天
  - 工具指标脚本：0.5 天
  - 异常检测脚本：0.5 天
  - 测试与文档：0.5 天

## 依赖

- ✅ Prisma client（已有）
- ✅ 数据库连接（已有）
- ✅ TypeScript + tsx（已有）

## 风险

- **数据量大时查询慢**：P0 先实现，如遇性能问题再优化（加索引、分页）
- **时区处理**：统一使用 UTC，报告中标注清楚

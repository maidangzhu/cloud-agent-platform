# Tasks — Agent Eval & Monitoring System

> 工作方式：每个阶段完成后停下，等人工检查通过，再进入下一阶段。每阶段 TDD：先写测试 → 实现 → 跑绿。

## 0. 地基（目录结构 + 工具函数）

- [ ] 0.1 创建 `scripts/eval/` 目录结构
- [ ] 0.2 创建 `scripts/eval/shared/db.ts` — 数据库连接（复用现有 prisma client）
- [ ] 0.3 创建 `scripts/eval/shared/time-range.ts` — 时间范围解析（--from/--to）
- [ ] 0.4 写测试：`time-range.test.ts` — 验证默认值（过去 24h）、自定义范围、边界情况
- [ ] 0.5 创建 `scripts/eval/shared/stats.ts` — 统计函数（mean, percentile, groupBy）
- [ ] 0.6 写测试：`stats.test.ts` — 验证各统计函数正确性（空数组、单元素、正常情况）
- [ ] 0.7 创建 `scripts/eval/shared/formatters.ts` — JSON/Text 格式化
- [ ] 0.8 写测试：`formatters.test.ts` — 验证 JSON 输出和 Text 可读性
- [ ] 0.9 所有 shared 层单元测试跑绿

## 1. Run 指标统计

- [ ] 1.1 创建 `scripts/eval/run-metrics.ts` — 主脚本框架（CLI 参数解析）
- [ ] 1.2 实现 `queryRunMetrics(from, to)` — 查询时间范围内的 Run 数据
- [ ] 1.3 实现 `calculateMetrics(runs)` — 计算指标（总数、状态分布、完成率、耗时分位数）
- [ ] 1.4 写测试：`run-metrics.integration.test.ts` — 创建测试 Run → 运行查询 → 验证指标正确
- [ ] 1.5 实现 Text 格式输出（表格、Emoji、对齐）
- [ ] 1.6 更新 `package.json`：添加 `"eval:runs": "tsx scripts/eval/run-metrics.ts"`
- [ ] 1.7 手动验证：`pnpm eval:runs --format text` 输出可读
- [ ] 1.8 手动验证：`pnpm eval:runs --format json` 输出合法 JSON
- [ ] 1.9 Run 指标测试跑绿

## 2. 工具调用指标统计

- [ ] 2.1 创建 `scripts/eval/tool-metrics.ts` — 主脚本框架
- [ ] 2.2 实现 `queryToolCallMetrics(from, to)` — 查询工具调用数据
- [ ] 2.3 实现 `calculateToolMetrics(toolCalls)` — 计算指标（总数、成功率、按工具分组统计）
- [ ] 2.4 写测试：`tool-metrics.integration.test.ts` — 创建测试 ToolCall → 验证统计正确
- [ ] 2.5 实现 Text 格式输出（工具列表、成功率百分比、耗时）
- [ ] 2.6 更新 `package.json`：添加 `"eval:tools": "tsx scripts/eval/tool-metrics.ts"`
- [ ] 2.7 手动验证：`pnpm eval:tools` 输出符合预期
- [ ] 2.8 工具指标测试跑绿

## 3. 卡住 Run 检测

- [ ] 3.1 创建 `scripts/eval/detect-stuck-runs.ts` — 主脚本框架
- [ ] 3.2 实现 `queryStuckRuns(threshold)` — 查询状态为 running 且超时无事件的 Run
- [ ] 3.3 实现 `diagnoseSuspect(run, lastEvent)` — 根据最后事件类型诊断原因
- [ ] 3.4 实现 `detectSlowRuns(runs, p95)` — 检测耗时超过 p95 的 Run
- [ ] 3.5 写测试：`detect-stuck.integration.test.ts` — 创建"卡住"场景 → 验证检测与诊断
- [ ] 3.6 实现 Text 格式输出（卡住列表、诊断建议、慢 Run Top 10）
- [ ] 3.7 更新 `package.json`：添加 `"eval:detect-stuck": "tsx scripts/eval/detect-stuck-runs.ts"`
- [ ] 3.8 手动验证：`pnpm eval:detect-stuck` 能识别线上卡住的 Run
- [ ] 3.9 异常检测测试跑绿

## 4. 文档与示例

- [ ] 4.1 创建 `docs/eval.md` — Eval 系统使用指南
- [ ] 4.2 文档包含：脚本列表、参数说明、输出示例、常见问题
- [ ] 4.3 更新 `README.md` — 添加 Eval 章节链接
- [ ] 4.4 添加示例输出截图（Text 格式）到文档
- [ ] 4.5 创建 `.github/workflows/eval.yml` — CI 中运行 Eval 测试（可选，P1）

## 5. 验收与部署

- [ ] 5.1 所有单元测试通过（shared 层）
- [ ] 5.2 所有集成测试通过（连真实数据库）
- [ ] 5.3 手动验证：对线上数据运行三个脚本，输出合理
- [ ] 5.4 代码审查通过
- [ ] 5.5 文档完整且清晰
- [ ] 5.6 合并到 main 分支

## 验收标准

### 功能验收

- [ ] `pnpm eval:runs` 输出 Run 指标报告（JSON + Text）
- [ ] `pnpm eval:tools` 输出工具调用指标报告（JSON + Text）
- [ ] `pnpm eval:detect-stuck` 输出异常 Run 列表（卡住 + 慢 Run）
- [ ] 所有脚本支持 `--from` / `--to` / `--format` 参数
- [ ] Text 格式人类可读（对齐、Emoji、清晰分组）
- [ ] JSON 格式机器可解析（合法 JSON、类型清晰）

### 质量验收

- [ ] 单元测试覆盖率 > 80%（shared 层）
- [ ] 集成测试覆盖所有主要场景
- [ ] 无 TypeScript 类型错误
- [ ] 代码风格符合项目规范（通过 lint）

### 性能验收

- [ ] 查询 1000 条 Run 记录 < 2 秒
- [ ] 查询 10000 条 ToolCall 记录 < 5 秒
- [ ] 检测卡住 Run < 3 秒

## 后续演进（P1）

- [ ] 实现 `scripts/eval/benchmark.ts` — Benchmark 测试执行器
- [ ] 创建标准测试用例库（简单任务、复杂任务、多轮对话）
- [ ] 实现性能回归检测（与历史 baseline 对比）
- [ ] 添加自动化报告生成（定时任务 + 邮件）
- [ ] 集成告警系统（Slack/Webhook）

## 测试数据准备

为了测试 Eval 脚本，需要准备以下测试场景：

### 正常场景
- [ ] 创建 10 个已完成的 Run（不同耗时分布）
- [ ] 创建 50 个成功的工具调用（5 种工具）

### 异常场景
- [ ] 创建 2 个失败的 Run（不同错误原因）
- [ ] 创建 1 个超时的 Run
- [ ] 创建 1 个"卡住"的 Run（状态 running，最后事件 10 分钟前）
- [ ] 创建 3 个慢 Run（耗时超过 p95）
- [ ] 创建 5 个失败的工具调用

### 边界场景
- [ ] 空时间范围（无 Run）
- [ ] 单个 Run
- [ ] 大量 Run（1000+）

## 技术债务

- [ ] 考虑添加数据库索引（createdAt, status）以优化查询性能
- [ ] 考虑分页查询（当 Run 数量 > 10000 时）
- [ ] 考虑缓存机制（频繁查询相同时间范围）

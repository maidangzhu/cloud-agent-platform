# ADR-0010：前端协议采用 AG-UI；表现层用 shadcn 自绘

**状态：** 已接受（2026-07-02）

## 决策

- 前端 ↔ Control Plane 的通信采用 **AG-UI（Agent-User Interaction Protocol）** 事件标准（CopilotKit 推的开放协议，走 SSE，事件驱动，双向）。
- **数据协议用 AG-UI，表现层用 shadcn 自绘。** 吃 AG-UI 的事件标准与客户端 SDK 解析，UI 皮自己用 shadcn 画，**不**直接用 CopilotKit 现成 UI 组件（风格与 shadcn 冲突）。
- markdown 渲染用 **streamdown**（流式友好）。

## 关键张力与落法

AG-UI 标准玩法是 agent backend 直接对前端开 SSE。但本项目 agent 在沙箱（不可信区），前端连 Control Plane，沙箱不能直连前端。因此：

```
沙箱 agent ──ingest（内部 AgentEvent）──> Control Plane ──翻译成 AG-UI 事件──> 前端 SSE
```

**AG-UI 只覆盖"前端 ↔ Control Plane"这一段；沙箱侧仍用自己的 ingest。** Control Plane 多担一个角色：把内部 AgentEvent 翻译成标准 AG-UI 事件流。

## 待决

- `AgentEventDTO` 是否直接对齐 AG-UI 事件 schema（`TEXT_MESSAGE_START/CONTENT/END`、`TOOL_CALL_START/ARGS/END`、`STATE_DELTA`、`RUN_STARTED/FINISHED`）。倾向对齐（前端可直接用现成解析、少写适配），代价是被其 schema 绑定。

## Human-in-the-loop

AG-UI 原生支持 agent 中途停下来问用户（通常实现成 client-side tool call，如 `ask_user` / `ApprovalRequired`）。这是明确要做的产品能力，但在发射后不管模型下需新增 run 状态 `waiting_for_input`——详见 OPEN-QUESTIONS DQ-1。

## 风险

AG-UI 相对新、生态在长。作为**前端渲染协议**风险可控（不行就自己渲染）；不指望它解决沙箱侧问题。

## 前端技术栈（已定）

- 组件：shadcn（全部）
- markdown：streamdown
- 渲染数据层：AG-UI 协议
- 与 design-system.md「领域命名、Vercel Chatbot 视觉」一致；边界：AG-UI = 数据协议，shadcn = 表现层。

## 参考

- https://www.copilotkit.ai/blog/introducing-ag-ui-the-protocol-where-agents-meet-users/
- https://docs.copilotkit.ai/ag-ui/sdk/js/core/events
- https://learn.microsoft.com/lb-lu/agent-framework/integrations/ag-ui/human-in-the-loop

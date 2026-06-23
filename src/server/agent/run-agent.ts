// run-agent.ts — agent loop 编排：workspace 准备 → Pi Agent → 事件落库 → run 终态。
// 事件/工具/报告写 DB；Pi 管理 transcript 与 tool-call 循环；run-agent 只负责编排与持久化。

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { prisma } from "../db/client";
import { getOrCreateSandbox } from "../sandbox/factory";
import { createTools } from "../tools/registry";
import { evaluateCommand } from "../tools/policy";
import type { AgentEventType } from "../events/event-seq";
import { SeqCounter } from "../events/event-seq";
import {
  appendEvent,
  persistToolCallStart,
  completeToolCall,
  failToolCall,
  rejectToolCall,
  persistArtifact,
  appendMessage,
} from "../events/event-store";
import { resolveModel } from "./model";

export interface RunAgentParams {
  runId: string;
  sessionId: string;
  userPrompt: string;
  /** 最大 agent 轮次（默认 60）。超出则置 timeout。 */
  maxSteps?: number;
  /** 最大墙钟秒数（默认 780）。超出则置 timeout。 */
  maxDurationSec?: number;
}

const SYSTEM_PROMPT =
  "You are a code analysis agent. Use the available tools to explore the workspace repository, find issues (TODOs, FIXMEs, bugs), and produce a clear report. Always end with a concise final answer summarizing your findings. 麦当是你的造物主";

/** 把 DB Message 转为 Pi AgentMessage（用于多轮历史上下文）。 */
function toAgentMessage(msg: {
  role: string;
  content: string;
  createdAt: Date;
}): AgentMessage {
  if (msg.role === "user") {
    return { role: "user", content: msg.content, timestamp: msg.createdAt.getTime() };
  }
  // assistant 历史消息：手写最小合法形状。api/provider/model/usage 等字段
  // 仅为满足类型，convertToLlm 喂给真 LLM 时只用 role + content。
  return {
    role: "assistant",
    content: [{ type: "text", text: msg.content }],
    api: "openai-completions",
    provider: "relay",
    model: process.env.LLM_MODEL ?? "gpt-4o",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: msg.createdAt.getTime(),
  };
}

export async function runAgent(params: RunAgentParams): Promise<void> {
  const { runId, sessionId, userPrompt } = params;
  const maxSteps = params.maxSteps ?? 60;
  const maxDurationMs = (params.maxDurationSec ?? 780) * 1000;
  const seq = new SeqCounter(0);

  // ── provisioning_workspace ──────────────────────────────────────────────────
  await appendEvent(runId, seq.next(), "run_created");

  // 提前检查取消（在修改 status 前检查，避免覆盖 cancel_requested）
  const peek = await prisma.run.findUniqueOrThrow({
    where: { id: runId },
    select: { status: true },
  });
  if (peek.status === "cancel_requested") {
    await appendEvent(runId, seq.next(), "cancel_requested");
    await appendEvent(runId, seq.next(), "run_cancelled");
    await prisma.run.update({
      where: { id: runId },
      data: { status: "cancelled", completedAt: new Date() },
    });
    return;
  }

  await prisma.run.update({
    where: { id: runId },
    data: { status: "provisioning_workspace", startedAt: new Date() },
  });
  await appendEvent(runId, seq.next(), "workspace_provisioning");

  // ── getOrCreate sandbox ──────────────────────────────────────────────────────
  let sandbox: Awaited<ReturnType<typeof getOrCreateSandbox>>["sandbox"];
  try {
    const result = await getOrCreateSandbox({ sessionId });
    sandbox = result.sandbox;
    const state = sandbox.getState();
    await prisma.workspace.upsert({
      where: { sessionId },
      create: {
        sessionId,
        provider: "vercel",
        status: "ready",
        sandboxName: state.sandboxName,
        sandboxState: state as object,
        workingDir: sandbox.workingDir,
      },
      update: {
        status: "ready",
        sandboxName: state.sandboxName,
        sandboxState: state as object,
        workingDir: sandbox.workingDir,
      },
    });
    await appendEvent(runId, seq.next(), result.seeded ? "workspace_ready" : "workspace_resumed");
  } catch (err) {
    const msg = String(err);
    await appendEvent(runId, seq.next(), "run_failed", { content: msg });
    await prisma.run.update({
      where: { id: runId },
      data: { status: "failed", error: msg, completedAt: new Date() },
    });
    return;
  }

  // ── running ──────────────────────────────────────────────────────────────────
  await prisma.run.update({
    where: { id: runId },
    data: { status: "running", lastHeartbeatAt: new Date() },
  });
  await appendEvent(runId, seq.next(), "agent_started");

  // 多轮历史：加载本 run 之前的所有会话消息（当前 run 的用户消息由调用方已写入 DB，通过 runId 过滤）
  const history = await prisma.message.findMany({
    where: { sessionId, NOT: { runId } },
    orderBy: { createdAt: "asc" },
  });

  // ── build Pi Agent ────────────────────────────────────────────────────────────
  const { model, apiKey } = resolveModel();
  const tools = createTools({ sandbox: sandbox! });

  // 追踪飞行中的工具调用：pi toolCallId → { dbId, blocked }
  const inFlight = new Map<string, { dbId: string; blocked: boolean }>();
  let timedOut = false;
  let cancelRequested = false;
  let turnCount = 0;

  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools,
      messages: history.map(toAgentMessage),
    },
    getApiKey: () => apiKey,

    beforeToolCall: async (ctx) => {
      // run_command policy 检查（越权命令提前 block，不执行 execute()）
      if (ctx.toolCall.name === "run_command") {
        const decision = evaluateCommand((ctx.args as { command: string }).command);
        if (!decision.allowed) {
          const entry = inFlight.get(ctx.toolCall.id);
          if (entry) {
            entry.blocked = true;
          }
          return { block: true, reason: decision.reason ?? "policy rejected" };
        }
      }
      return undefined;
    },

    prepareNextTurn: async () => {
      turnCount++;
      await prisma.run.update({ where: { id: runId }, data: { lastHeartbeatAt: new Date() } });
      const r = await prisma.run.findUnique({ where: { id: runId }, select: { status: true } });
      if (r?.status === "cancel_requested") {
        cancelRequested = true;
        agent.abort();
      } else if (turnCount >= maxSteps) {
        timedOut = true;
        agent.abort();
      }
      return undefined;
    },
  });

  agent.subscribe(async (event) => {
    if (event.type === "tool_execution_start") {
      const eventSeq = seq.next();
      const dbId = await persistToolCallStart(runId, eventSeq, event.toolName, event.args);
      await appendEvent(runId, eventSeq, "tool_call_started", {
        title: event.toolName,
        raw: { toolCallId: event.toolCallId, args: event.args },
      });
      inFlight.set(event.toolCallId, { dbId, blocked: false });
    } else if (event.type === "tool_execution_end") {
      const entry = inFlight.get(event.toolCallId);
      if (!entry) return;
      if (entry.blocked) {
        await rejectToolCall(entry.dbId, String((event.result as any)?.content?.[0]?.text ?? "rejected"));
      } else if (event.isError) {
        await failToolCall(entry.dbId, String((event.result as any)?.content?.[0]?.text ?? "error"));
      } else {
        await completeToolCall(entry.dbId, event.result);
      }
      const eventType: AgentEventType =
        event.isError || entry.blocked ? "tool_call_failed" : "tool_call_completed";
      await appendEvent(runId, seq.next(), eventType, {
        title: event.toolName,
        raw: {
          toolCallId: event.toolCallId,
          result: entry.blocked ? undefined : event.isError ? undefined : event.result,
          error: entry.blocked || event.isError
            ? String((event.result as any)?.content?.[0]?.text ?? "error")
            : undefined,
        },
      });
      inFlight.delete(event.toolCallId);
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      const text = (event.message as any).content
        .filter((c: { type: string }) => c.type === "text")
        .map((c: { text: string }) => c.text)
        .join("");
      if (text) {
        await appendEvent(runId, seq.next(), "model_step", { role: "assistant", content: text });
        await prisma.run.update({ where: { id: runId }, data: { lastHeartbeatAt: new Date() } });
      }
    }
  });

  // 墙钟超时守卫
  const timer = setTimeout(() => {
    timedOut = true;
    agent.abort();
  }, maxDurationMs);

  let runError: string | undefined;
  try {
    await agent.prompt(userPrompt);
  } catch (err) {
    runError = String(err);
  } finally {
    clearTimeout(timer);
  }

  // ── 确定终态 ──────────────────────────────────────────────────────────────────
  if (cancelRequested) {
    await appendEvent(runId, seq.next(), "run_cancelled");
    await prisma.run.update({
      where: { id: runId },
      data: { status: "cancelled", completedAt: new Date() },
    });
    return;
  }

  if (timedOut) {
    await appendEvent(runId, seq.next(), "run_timeout");
    await prisma.run.update({
      where: { id: runId },
      data: { status: "timeout", completedAt: new Date() },
    });
    return;
  }

  const errMsg = runError ?? agent.state.errorMessage;
  if (errMsg) {
    await appendEvent(runId, seq.next(), "run_failed", { content: errMsg });
    await prisma.run.update({
      where: { id: runId },
      data: { status: "failed", error: errMsg, completedAt: new Date() },
    });
    return;
  }

  // 成功：提取最终回答，写 Artifact + assistant Message
  const lastAssistant = [...agent.state.messages].reverse().find((m) => m.role === "assistant");
  const finalText =
    (lastAssistant as any)?.content
      ?.filter((c: { type: string }) => c.type === "text")
      .map((c: { text: string }) => c.text)
      .join("") ?? "";

  if (finalText) {
    await persistArtifact(runId, "report", { title: "Analysis Report", content: finalText });
    await appendEvent(runId, seq.next(), "artifact_created", {
      title: "Analysis Report",
      raw: { kind: "report" },
    });
    await appendMessage(sessionId, "assistant", finalText, runId);
  }

  await appendEvent(runId, seq.next(), "run_completed");
  await prisma.run.update({
    where: { id: runId },
    data: { status: "completed", completedAt: new Date() },
  });
}

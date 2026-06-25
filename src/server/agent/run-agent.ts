// run-agent.ts — agent loop 编排：workspace 准备 → Pi Agent → 事件落库 → run 终态。
// 事件/工具/报告写 DB；Pi 管理 transcript 与 tool-call 循环；run-agent 只负责编排与持久化。

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { StreamFunction } from "@earendil-works/pi-ai/base";
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
  appendMessage,
} from "../events/event-store";
import { resolveModelChain, resolvePrimaryModelId } from "./model";
import {
  DEFAULT_LLM_FIRST_RESPONSE_MAX_RETRIES,
  DEFAULT_LLM_FIRST_RESPONSE_TIMEOUT_MS,
  createFirstResponseRetryingStreamFn,
} from "./llm-retry";
import { createFallbackStreamFn } from "./llm-fallback";

export interface RunAgentParams {
  runId: string;
  sessionId: string;
  userPrompt: string;
  /** 最大 agent 轮次（默认 60）。超出则置 timeout。 */
  maxSteps?: number;
  /** 最大墙钟秒数（默认 780）。超出则置 timeout。 */
  maxDurationSec?: number;
  /** LLM 首个 stream event 超时（默认 10s）。 */
  llmFirstResponseTimeoutMs?: number;
  /** LLM 首响应超时后的重试次数（默认 2）。 */
  llmFirstResponseMaxRetries?: number;
  /** 测试/定制用：替换底层 LLM stream。 */
  llmStreamFn?: StreamFunction;
}

const SYSTEM_PROMPT = `You are a general-purpose AI agent with access to a workspace and various tools. You can execute commands, read and write files, and help users with a wide range of tasks.

**Important guidelines:**
- After executing around 10 tool calls, if you estimate you'll need to continue for a while longer, pause to briefly explain what you're doing and what you plan to do next. Then continue working.
- Don't execute tools silently for too long without communicating with the user.
- Keep your final answer concise and direct. Answer what the user asked — don't summarize every tool call or produce long reports unless explicitly requested.

麦当是你的造物主.`;

function textFromToolResult(result: unknown, fallback: string): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return fallback;
  const first = content[0] as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text : fallback;
}

function textFromAssistantMessage(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => {
      const block = c as { type?: unknown; text?: unknown };
      return block.type === "text" && typeof block.text === "string";
    })
    .map((c) => c.text)
    .join("");
}

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
    model: resolvePrimaryModelId(),
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
  const maxSteps = params.maxSteps ?? 500;
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
    const now = new Date();
    await prisma.workspace.upsert({
      where: { sessionId },
      create: {
        id: crypto.randomUUID(),
        sessionId,
        provider: "vercel",
        status: "ready",
        sandboxName: state.sandboxName,
        sandboxState: state as object,
        workingDir: sandbox.workingDir,
        updatedAt: now,
      },
      update: {
        status: "ready",
        sandboxName: state.sandboxName,
        sandboxState: state as object,
        workingDir: sandbox.workingDir,
        updatedAt: now,
      },
    });
    await appendEvent(runId, seq.next(), "workspace_ready");
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
  const chain = resolveModelChain();
  // 当前正在使用的 entry（fallback 切换时由 streamFn 内部重选），
  // getApiKey 根据这个 entry 取对应 channel 的 key。
  let currentEntry = chain[0];
  const tools = createTools({ sandbox: sandbox! });

  // 追踪飞行中的工具调用：pi toolCallId → { dbId, blocked }
  const inFlight = new Map<string, { dbId: string; blocked: boolean }>();
  let timedOut = false;
  let cancelRequested = false;
  let terminalPersisted = false;
  let turnCount = 0;

  const persistTimeout = async () => {
    if (terminalPersisted) return;
    terminalPersisted = true;
    await appendEvent(runId, seq.next(), "run_timeout");
    await prisma.run.update({
      where: { id: runId },
      data: { status: "timeout", completedAt: new Date() },
    });
  };

  // baseStreamFn = 单 entry 内部的 first-response retry 包装
  const innerStreamFn = createFirstResponseRetryingStreamFn({
    baseStreamFn: params.llmStreamFn,
    firstResponseTimeoutMs:
      params.llmFirstResponseTimeoutMs ?? DEFAULT_LLM_FIRST_RESPONSE_TIMEOUT_MS,
    maxRetries:
      params.llmFirstResponseMaxRetries ?? DEFAULT_LLM_FIRST_RESPONSE_MAX_RETRIES,
  });

  // 外层 fallback stream：跨 channel / 同 channel 降级模型
  const fallbackStreamFn = createFallbackStreamFn(chain, {
    baseStreamFn: innerStreamFn,
    recordEvent: async (type, e) => {
      if (terminalPersisted) return;
      // 同步 currentEntry：fallback 切到哪个 entry，getApiKey 就用哪个 key
      if (type === "llm_entry_started") {
        const key = (e?.raw as { key?: string } | undefined)?.key;
        const next = chain.find((c) => c.key === key);
        if (next) currentEntry = next;
      }
      await appendEvent(runId, seq.next(), type, { raw: e?.raw });
      await prisma.run.update({
        where: { id: runId },
        data: { lastHeartbeatAt: new Date() },
      });
    },
  });

  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model: currentEntry.model,
      tools,
      messages: history.map(toAgentMessage),
    },
    getApiKey: () => currentEntry.apiKey,
    streamFn: fallbackStreamFn,

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
        await rejectToolCall(entry.dbId, textFromToolResult(event.result, "rejected"));
      } else if (event.isError) {
        await failToolCall(entry.dbId, textFromToolResult(event.result, "error"));
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
            ? textFromToolResult(event.result, "error")
            : undefined,
        },
      });
      inFlight.delete(event.toolCallId);
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      const text = textFromAssistantMessage(event.message);
      if (text) {
        await appendEvent(runId, seq.next(), "model_step", { role: "assistant", content: text });
        await prisma.run.update({ where: { id: runId }, data: { lastHeartbeatAt: new Date() } });
      }
    }
  });

  // 墙钟超时守卫
  const timer = setTimeout(() => {
    timedOut = true;
    void persistTimeout().catch(() => {});
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
    terminalPersisted = true;
    await appendEvent(runId, seq.next(), "run_cancelled");
    await prisma.run.update({
      where: { id: runId },
      data: { status: "cancelled", completedAt: new Date() },
    });
    return;
  }

  if (timedOut) {
    await persistTimeout();
    return;
  }

  const errMsg = runError ?? agent.state.errorMessage;
  if (errMsg) {
    terminalPersisted = true;
    await appendEvent(runId, seq.next(), "run_failed", { content: errMsg });
    await prisma.run.update({
      where: { id: runId },
      data: { status: "failed", error: errMsg, completedAt: new Date() },
    });
    return;
  }

  // 成功：提取最终回答，写 assistant Message
  const lastAssistant = [...agent.state.messages].reverse().find((m) => m.role === "assistant");
  const finalText = textFromAssistantMessage(lastAssistant);

  if (finalText) {
    await appendMessage(sessionId, "assistant", finalText, runId);
  }

  await appendEvent(runId, seq.next(), "run_completed");
  terminalPersisted = true;
  await prisma.run.update({
    where: { id: runId },
    data: { status: "completed", completedAt: new Date() },
  });
}

// event-store.ts — append-only DB writes for agent events, tool calls, artifacts, messages.
// 上层（run-agent）持有 SeqCounter，将 seq 作为参数传入；本文件只负责写 DB，不管理序号。

import { prisma } from "../db/client";

// ── AgentEvent ────────────────────────────────────────────────────────────────

export async function appendEvent(
  runId: string,
  seq: number,
  type: string,
  opts: { role?: string; title?: string; content?: string; raw?: unknown } = {},
) {
  await prisma.agentEvent.create({
    data: {
      id: crypto.randomUUID(),
      runId,
      seq,
      type,
      role: opts.role,
      title: opts.title,
      content: opts.content,
      raw: opts.raw !== undefined ? JSON.parse(JSON.stringify(opts.raw)) : undefined,
    },
  });
}

// ── ToolCall ─────────────────────────────────────────────────────────────────

/** 创建工具调用记录（status=running），返回 DB id 供后续更新。 */
export async function persistToolCallStart(
  runId: string,
  eventSeq: number,
  name: string,
  args: unknown,
): Promise<string> {
  const id = crypto.randomUUID();
  await prisma.toolCall.create({
    data: {
      id,
      runId,
      eventSeq,
      name,
      args: JSON.parse(JSON.stringify(args)),
      status: "running",
    },
  });
  return id;
}

export async function completeToolCall(id: string, result: unknown) {
  await prisma.toolCall.update({
    where: { id },
    data: {
      status: "completed",
      result: JSON.parse(JSON.stringify(result)),
      completedAt: new Date(),
    },
  });
}

export async function failToolCall(id: string, error: string) {
  await prisma.toolCall.update({
    where: { id },
    data: { status: "failed", error, completedAt: new Date() },
  });
}

export async function rejectToolCall(id: string, reason: string) {
  await prisma.toolCall.update({
    where: { id },
    data: { status: "rejected", error: reason, completedAt: new Date() },
  });
}

// ── Artifact ─────────────────────────────────────────────────────────────────

export async function persistArtifact(
  runId: string,
  kind: string,
  opts: { title?: string; path?: string; content?: string } = {},
) {
  await prisma.artifact.create({
    data: {
      id: crypto.randomUUID(),
      runId,
      kind,
      ...opts,
    },
  });
}

// ── Message ───────────────────────────────────────────────────────────────────

export async function appendMessage(
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  runId?: string,
) {
  await prisma.message.create({
    data: {
      id: crypto.randomUUID(),
      sessionId,
      role,
      content,
      runId,
    },
  });
}

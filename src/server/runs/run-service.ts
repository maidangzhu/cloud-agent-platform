// run-service.ts — derivedUiState 推导 + Run/Session/Message/Event DTO 转换。
import type {
  AgentEventDTO,
  ArtifactDTO,
  DerivedUiState,
  MessageDTO,
  RunDTO,
  SessionDTO,
  ToolCallDTO,
} from "@/lib/api-contract";
import type {
  AgentEvent,
  Artifact,
  Message,
  Run,
  Session,
  ToolCall,
} from "@prisma/client";

/** 心跳新鲜度阈值。 */
const STALE_MS = 60_000;  // >60s → possibly_running
const DEAD_MS = 120_000;  // >120s → interrupted

export function derivedUiState(
  status: string,
  lastHeartbeatAt: Date | null,
): DerivedUiState {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "timeout") return "timeout";
  if (status === "cancelled" || status === "cancel_requested") return "cancelled";
  if (status === "interrupted") return "interrupted";
  if (status === "created") return "idle";

  // provisioning_workspace | running — 按心跳新鲜度判断
  const age = Date.now() - (lastHeartbeatAt?.getTime() ?? 0);
  if (age < STALE_MS) return "running";
  if (age < DEAD_MS) return "possibly_running";
  return "interrupted";
}

export function toSessionDTO(s: Session): SessionDTO {
  return {
    id: s.id,
    title: s.title,
    status: s.status as SessionDTO["status"],
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export function toRunDTO(r: Run): RunDTO {
  return {
    id: r.id,
    sessionId: r.sessionId,
    status: r.status as RunDTO["status"],
    userPrompt: r.userPrompt,
    derivedUiState: derivedUiState(r.status, r.lastHeartbeatAt),
    startedAt: r.startedAt?.toISOString(),
    completedAt: r.completedAt?.toISOString(),
    error: r.error ?? undefined,
    createdAt: r.createdAt.toISOString(),
  };
}

export function toMessageDTO(m: Message): MessageDTO {
  return {
    id: m.id,
    role: m.role as MessageDTO["role"],
    content: m.content,
    runId: m.runId ?? undefined,
    createdAt: m.createdAt.toISOString(),
  };
}

export function toAgentEventDTO(e: AgentEvent): AgentEventDTO {
  const raw = e.raw as Record<string, unknown> | null;
  let payload: AgentEventDTO["payload"];
  if (raw) {
    if (e.type === "tool_call_started") payload = { args: raw.args };
    else if (e.type === "tool_call_completed") payload = { result: raw.result };
    else if (e.type === "tool_call_failed") payload = { error: raw.error as string };
  }
  return {
    seq: e.seq,
    type: e.type,
    role: e.role ?? undefined,
    title: e.title ?? undefined,
    content: e.content ?? undefined,
    payload,
    createdAt: e.createdAt.toISOString(),
  };
}

export function toToolCallDTO(tc: ToolCall): ToolCallDTO {
  return {
    id: tc.id,
    name: tc.name,
    status: tc.status,
    args: tc.args,
    result: tc.result ?? undefined,
    error: tc.error ?? undefined,
    eventSeq: tc.eventSeq,
  };
}

export function toArtifactDTO(a: Artifact): ArtifactDTO {
  return {
    id: a.id,
    kind: a.kind,
    title: a.title ?? undefined,
    path: a.path ?? undefined,
    content: a.content ?? undefined,
    createdAt: a.createdAt.toISOString(),
  };
}

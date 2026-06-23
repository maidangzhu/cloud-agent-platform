// 接口契约 —— 前后端共用的单一事实源。
// 规范说明见 docs/api-contract.md。纯类型 + 纯函数，零外部依赖，可单元测试。

// ── 统一响应信封 ──────────────────────────────────────────────────────
export interface ApiResponse<T> {
  /** 0 = 成功；非 0 = 业务错误码（见 ApiCode）。 */
  code: number;
  /** 人类可读信息；成功时通常 "ok"。 */
  message: string;
  /** 成功时为业务负载；失败时为 null。 */
  data: T | null;
}

// ── 错误码（集中登记，前端从此引用）────────────────────────────────────
export const ApiCode = {
  OK: 0,
  /** 请求参数错误（校验失败） */
  BAD_REQUEST: 1001,
  /** 邀请码无效 / 未授权 */
  UNAUTHORIZED: 1002,
  /** 资源不存在 */
  NOT_FOUND: 1003,
  /** 状态冲突（重复操作等） */
  CONFLICT: 1004,
  /** Run 已终态，无法取消 */
  RUN_NOT_CANCELABLE: 2001,
  /** Workspace 准备失败 */
  WORKSPACE_FAILED: 2002,
  /** 服务端内部错误 */
  INTERNAL: 5000,
} as const;

export type ApiCode = (typeof ApiCode)[keyof typeof ApiCode];

/** code → 默认 HTTP status（fail 未显式指定时使用）。 */
const CODE_TO_HTTP: Record<number, number> = {
  [ApiCode.OK]: 200,
  [ApiCode.BAD_REQUEST]: 400,
  [ApiCode.UNAUTHORIZED]: 401,
  [ApiCode.NOT_FOUND]: 404,
  [ApiCode.CONFLICT]: 409,
  [ApiCode.RUN_NOT_CANCELABLE]: 409,
  [ApiCode.WORKSPACE_FAILED]: 422,
  [ApiCode.INTERNAL]: 500,
};

export function httpStatusForCode(code: number): number {
  return CODE_TO_HTTP[code] ?? (code === 0 ? 200 : 500);
}

// ── 构造 helper（服务端用）────────────────────────────────────────────
export function ok<T>(data: T, message = "ok"): ApiResponse<T> {
  return { code: ApiCode.OK, message, data };
}

export function fail(
  code: number,
  message: string,
  status?: number,
): { body: ApiResponse<null>; status: number } {
  return {
    body: { code, message, data: null },
    status: status ?? httpStatusForCode(code),
  };
}

/** 把信封包成 Web 标准 Response（route handler 直接 return）。 */
export function apiJson<T>(body: ApiResponse<T>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// ── 视图 DTO（接口返回的形状，非裸 DB 行；时间统一 ISO 字符串）──────────
export type SessionStatusDTO = "active" | "archived";

export type RunStatusDTO =
  | "created"
  | "provisioning_workspace"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "cancel_requested"
  | "cancelled"
  | "interrupted";

/** 由 status + 心跳新鲜度推导的 UI 存活状态（见 architecture §8）。 */
export type DerivedUiState =
  | "idle"
  | "running"
  | "possibly_running"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export interface SessionDTO {
  id: string;
  title: string;
  status: SessionStatusDTO;
  createdAt: string;
  updatedAt: string;
}

export interface MessageDTO {
  id: string;
  role: "user" | "assistant";
  content: string;
  runId?: string;
  createdAt: string;
}

export interface RunDTO {
  id: string;
  sessionId: string;
  status: RunStatusDTO;
  userPrompt: string;
  derivedUiState: DerivedUiState;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  createdAt: string;
  events?: AgentEventDTO[]; // 可选：从 DB 加载时包含
}

export interface AgentEventDTO {
  seq: number;
  type: string;
  role?: string;
  title?: string;
  content?: string;
  /** tool_call_started 时含 args；tool_call_completed/failed 时含 result/error。 */
  payload?: { args?: unknown; result?: unknown; error?: string };
  createdAt: string;
}

export interface ToolCallDTO {
  id: string;
  name: string;
  status: string;
  args: unknown;
  result?: unknown;
  error?: string;
  eventSeq: number;
}

export interface ArtifactDTO {
  id: string;
  kind: string;
  title?: string;
  path?: string;
  content?: string;
  createdAt: string;
}

// ── 端点响应 data 形状 ────────────────────────────────────────────────
export interface InviteVerifyData {
  valid: boolean;
}

export interface SessionDetailData {
  session: SessionDTO;
  messages: MessageDTO[];
  runs: RunDTO[];
}

export interface CreateRunData {
  run: RunDTO;
}

export interface RunDetailData {
  run: RunDTO;
  events: AgentEventDTO[];
  toolCalls: ToolCallDTO[];
  artifacts: ArtifactDTO[];
}

// ── SSE 事件契约（/api/runs/:id/events，不套信封）─────────────────────
export type SSEEventType =
  | string // AgentEvent.type
  | "snapshot"
  | "ping"
  | "done";

/** 连接建立时首条 snapshot 事件的 data。 */
export interface SSESnapshotData {
  run: RunDTO;
  events: AgentEventDTO[];
}

export interface SSEMessage<T = unknown> {
  event: SSEEventType;
  data: T;
}

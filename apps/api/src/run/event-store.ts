import { randomUUID } from "node:crypto";
import { Prisma, prisma } from "@cap/db";

export const INGEST_SEQ_CONFLICT = "INGEST_SEQ_CONFLICT" as const;
export const VALIDATION_FAILED = "VALIDATION_FAILED" as const;

const NULL_PAYLOAD_EVENT_TYPES = [
  "run_created",
  "sandbox_provisioning",
  "sandbox_ready",
  "runner_started",
  "agent_started",
  "run_cancelled",
] as const;

export const RUN_EVENT_TYPES = [
  ...NULL_PAYLOAD_EVENT_TYPES,
  "agent_thinking",
  "agent_message",
  "tool_call_started",
  "tool_call_completed",
  "tool_call_failed",
  "file_written",
  "source_recorded",
  "artifact_started",
  "artifact_delta",
  "artifact_created",
  "artifact_updated",
  "artifact_failed",
  "run_completed",
  "run_failed",
  "run_timeout",
  "run_waiting_for_input",
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export type ArtifactKind = "text" | "code" | "sheet" | "image";
export type SourceKind = "url" | "file" | "command" | "search_result" | "manual";

export type RunEventPayloadMap = {
  run_created: null;
  sandbox_provisioning: null;
  sandbox_ready: null;
  runner_started: null;
  agent_started: null;
  agent_thinking: { model?: string };
  agent_message: { messageId: string };
  tool_call_started: { toolCallId: string; name: string; args: unknown };
  tool_call_completed: {
    toolCallId: string;
    name: string;
    result: unknown;
    durationMs?: number;
  };
  tool_call_failed: {
    toolCallId: string;
    name: string;
    error: string;
    durationMs?: number;
  };
  file_written: {
    fileId: string;
    path: string;
    size: number;
    contentHash: string;
  };
  source_recorded: {
    sourceId: string;
    kind: SourceKind;
    uri?: string;
    title?: string;
  };
  artifact_started: {
    artifactId: string;
    title: string;
    kind: ArtifactKind;
  };
  artifact_delta: { artifactId: string; deltaText: string };
  artifact_created: {
    artifactId: string;
    title: string;
    kind: ArtifactKind;
    version: number;
  };
  artifact_updated: {
    artifactId: string;
    title: string;
    kind: ArtifactKind;
    version: number;
    previousVersion: number;
  };
  artifact_failed: { artifactId?: string; error: string };
  run_completed: { totalTokens?: number; durationMs: number };
  run_failed: { errorCode?: string };
  run_timeout: { lastHeartbeatAt?: string };
  run_cancelled: null;
  run_waiting_for_input: { question: string; options?: string[] };
};

export type RunEventInput<T extends RunEventType = RunEventType> = {
  runId: string;
  seq: number;
  type: T;
  role?: string;
  title?: string;
  content?: string;
  payload: RunEventPayloadMap[T];
};

export type InsertRunEventResult =
  | { ok: true; idempotent: boolean; eventId: string }
  | { ok: false; code: typeof INGEST_SEQ_CONFLICT | typeof VALIDATION_FAILED; message: string };

type PersistedEventBody = {
  seq: number;
  type: string;
  role: string | null;
  title: string | null;
  content: string | null;
  payload: unknown;
};

const EVENT_TYPE_SET = new Set<string>(RUN_EVENT_TYPES);
const NULL_PAYLOAD_TYPE_SET = new Set<string>(NULL_PAYLOAD_EVENT_TYPES);
const ARTIFACT_KINDS = new Set<string>(["text", "code", "sheet", "image"]);
const SOURCE_KINDS = new Set<string>([
  "url",
  "file",
  "command",
  "search_result",
  "manual",
]);

const EVENT_ORDER_GROUPS: readonly (readonly RunEventType[])[] = [
  ["run_created"],
  ["sandbox_provisioning"],
  ["sandbox_ready"],
  ["runner_started"],
  ["agent_started"],
  ["tool_call_started"],
  ["tool_call_completed", "tool_call_failed"],
  ["artifact_started"],
  ["artifact_created", "artifact_failed"],
  ["run_completed", "run_failed", "run_timeout", "run_cancelled"],
];

export function isRunEventType(value: string): value is RunEventType {
  return EVENT_TYPE_SET.has(value);
}

export function isRunEventTypeBefore(
  earlier: RunEventType,
  later: RunEventType,
): boolean {
  let earlierIndex = -1;
  let laterIndex = -1;

  for (let i = 0; i < EVENT_ORDER_GROUPS.length; i += 1) {
    const group = EVENT_ORDER_GROUPS[i];
    if (group.includes(earlier)) earlierIndex = i;
    if (group.includes(later)) laterIndex = i;
  }

  return earlierIndex >= 0 && laterIndex >= 0 && earlierIndex < laterIndex;
}

export function validateRunEventPayload(
  type: string,
  payload: unknown,
): { ok: true } | { ok: false; message: string } {
  if (!isRunEventType(type)) {
    return { ok: false, message: `unknown event type: ${type}` };
  }

  if (NULL_PAYLOAD_TYPE_SET.has(type)) {
    return payload === null
      ? { ok: true }
      : { ok: false, message: `${type} payload must be null` };
  }

  if (!isPlainObject(payload)) {
    return { ok: false, message: `${type} payload must be an object` };
  }

  switch (type) {
    case "agent_thinking":
      return validateShape(payload, [], { model: isString });
    case "agent_message":
      return validateShape(payload, [["messageId", isString]], {});
    case "tool_call_started":
      return validateShape(
        payload,
        [
          ["toolCallId", isString],
          ["name", isString],
          ["args", isPresent],
        ],
        {},
      );
    case "tool_call_completed":
      return validateShape(
        payload,
        [
          ["toolCallId", isString],
          ["name", isString],
          ["result", isPresent],
        ],
        { durationMs: isNonNegativeNumber },
      );
    case "tool_call_failed":
      return validateShape(
        payload,
        [
          ["toolCallId", isString],
          ["name", isString],
          ["error", isString],
        ],
        { durationMs: isNonNegativeNumber },
      );
    case "file_written":
      return validateShape(
        payload,
        [
          ["fileId", isString],
          ["path", isString],
          ["size", isNonNegativeNumber],
          ["contentHash", isString],
        ],
        {},
      );
    case "source_recorded":
      return validateShape(
        payload,
        [
          ["sourceId", isString],
          ["kind", (value) => isString(value) && SOURCE_KINDS.has(value)],
        ],
        { uri: isString, title: isString },
      );
    case "artifact_started":
      return validateShape(
        payload,
        [
          ["artifactId", isString],
          ["title", isString],
          ["kind", isArtifactKind],
        ],
        {},
      );
    case "artifact_delta":
      return validateShape(
        payload,
        [
          ["artifactId", isString],
          ["deltaText", isString],
        ],
        {},
      );
    case "artifact_created":
      return validateShape(
        payload,
        [
          ["artifactId", isString],
          ["title", isString],
          ["kind", isArtifactKind],
          ["version", isPositiveInteger],
        ],
        {},
      );
    case "artifact_updated":
      return validateShape(
        payload,
        [
          ["artifactId", isString],
          ["title", isString],
          ["kind", isArtifactKind],
          ["version", isPositiveInteger],
          ["previousVersion", isPositiveInteger],
        ],
        {},
      );
    case "artifact_failed":
      return validateShape(payload, [["error", isString]], {
        artifactId: isString,
      });
    case "run_completed":
      return validateShape(payload, [["durationMs", isNonNegativeNumber]], {
        totalTokens: isNonNegativeNumber,
      });
    case "run_failed":
      return validateShape(payload, [], { errorCode: isString });
    case "run_timeout":
      return validateShape(payload, [], { lastHeartbeatAt: isString });
    case "run_waiting_for_input":
      return validateShape(payload, [["question", isString]], {
        options: isStringArray,
      });
    default:
      return { ok: false, message: `unhandled event type: ${type}` };
  }
}

export async function insertRunEvent(
  input: RunEventInput,
): Promise<InsertRunEventResult> {
  if (!Number.isInteger(input.seq) || input.seq < 1) {
    return {
      ok: false,
      code: VALIDATION_FAILED,
      message: "seq must be a positive integer",
    };
  }

  const payloadValidation = validateRunEventPayload(input.type, input.payload);
  if (payloadValidation.ok === false) {
    return {
      ok: false,
      code: VALIDATION_FAILED,
      message: payloadValidation.message,
    };
  }

  const existing = await prisma.runEvent.findUnique({
    where: { runId_seq: { runId: input.runId, seq: input.seq } },
  });
  if (existing) {
    return sameBody(toPersistedBody(input), persistedBodyFromRow(existing))
      ? { ok: true, idempotent: true, eventId: existing.id }
      : {
          ok: false,
          code: INGEST_SEQ_CONFLICT,
          message: "event seq already exists with different body",
        };
  }

  const maxSeq = await prisma.runEvent.aggregate({
    where: { runId: input.runId },
    _max: { seq: true },
  });
  // 只拒绝严格小于当前 max 的回填（真正的乱序插入，例如已有 seq=1,3 又
  // 想插 seq=2）。刻意不用 <=：如果 input.seq 正好等于 maxSeq，唯一的
  // 可能是另一个并发请求刚把这个 seq 插进去——这种情况不该在这里提前
  // 拒绝，应该放给下面的 create() 去闯真实的数据库唯一约束，由 catch
  // 分支基于内容判断是幂等重试还是真冲突（否则一次合法的同内容并发重
  // 试会被这里误判成 INGEST_SEQ_CONFLICT，见并发测试）。
  if (maxSeq._max.seq !== null && input.seq < maxSeq._max.seq) {
    return {
      ok: false,
      code: INGEST_SEQ_CONFLICT,
      message: "event seq must be greater than the current max seq",
    };
  }

  const run = await prisma.agentRun.findUnique({ where: { id: input.runId } });
  if (!run) {
    return { ok: false, code: VALIDATION_FAILED, message: "run not found" };
  }

  try {
    const created = await prisma.runEvent.create({
      data: {
        id: randomUUID(),
        workspaceId: run.workspaceId,
        threadId: run.threadId,
        runId: run.id,
        seq: input.seq,
        type: input.type,
        role: input.role ?? null,
        title: input.title ?? null,
        content: input.content ?? null,
        raw: input.payload as Prisma.InputJsonValue,
      },
    });
    return { ok: true, idempotent: false, eventId: created.id };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const conflicting = await prisma.runEvent.findUnique({
        where: { runId_seq: { runId: input.runId, seq: input.seq } },
      });
      if (conflicting && sameBody(toPersistedBody(input), persistedBodyFromRow(conflicting))) {
        return { ok: true, idempotent: true, eventId: conflicting.id };
      }
      return {
        ok: false,
        code: INGEST_SEQ_CONFLICT,
        message: "event seq already exists with different body",
      };
    }
    throw error;
  }
}

function persistedBodyFromRow(row: {
  seq: number;
  type: string;
  role: string | null;
  title: string | null;
  content: string | null;
  raw: Prisma.JsonValue | null;
}): PersistedEventBody {
  return {
    seq: row.seq,
    type: row.type,
    role: row.role,
    title: row.title,
    content: row.content,
    payload: row.raw,
  };
}

function toPersistedBody(input: RunEventInput): PersistedEventBody {
  return {
    seq: input.seq,
    type: input.type,
    role: input.role ?? null,
    title: input.title ?? null,
    content: input.content ?? null,
    payload: input.payload,
  };
}

function sameBody(left: PersistedEventBody, right: PersistedEventBody): boolean {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function isUniqueConstraintError(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError & { code: "P2002" } {
  // 之前这里用 isPlainObject 判断，但真实的 Prisma 错误是
  // PrismaClientKnownRequestError 的类实例（继承自 Error），原型链
  // 上永远不是 Object.prototype，isPlainObject 对它恒为 false——这个
  // 分支实际上从未真正捕获过 P2002，并发写入撞唯一约束时会直接把异常
  // 抛出到调用方（见并发测试）。改成用 instanceof 判断真实的错误类型。
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

type Validator = (value: unknown) => boolean;
type RequiredField = readonly [key: string, validator: Validator];

function validateShape(
  payload: Record<string, unknown>,
  required: readonly RequiredField[],
  optional: Record<string, Validator>,
): { ok: true } | { ok: false; message: string } {
  const requiredKeys = new Set(required.map(([key]) => key));
  const optionalKeys = new Set(Object.keys(optional));

  for (const [key, validator] of required) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      return { ok: false, message: `payload missing ${key}` };
    }
    if (!validator(payload[key])) {
      return { ok: false, message: `payload.${key} has invalid type` };
    }
  }

  for (const [key, value] of Object.entries(payload)) {
    if (requiredKeys.has(key)) continue;
    const validator = optionalKeys.has(key) ? optional[key] : undefined;
    if (validator) {
      if (!validator(value)) {
        return { ok: false, message: `payload.${key} has invalid type` };
      }
      continue;
    }
    return { ok: false, message: `payload has unexpected field ${key}` };
  }

  return { ok: true };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isPresent(value: unknown): boolean {
  return value !== undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isArtifactKind(value: unknown): value is ArtifactKind {
  return isString(value) && ARTIFACT_KINDS.has(value);
}

import { createHmac, timingSafeEqual } from "node:crypto";

export const RUN_TOKEN_TYPE = "cap.run_token.v1" as const;

export type RunTokenBinding = {
  userId: string;
  workspaceId: string;
  threadId: string;
  runId: string;
};

export type RunTokenClaims = RunTokenBinding & {
  typ: typeof RUN_TOKEN_TYPE;
  iat: number;
  exp: number;
};

export type IssueRunTokenOptions = RunTokenBinding & {
  secret?: string;
  ttlSeconds?: number;
  now?: Date;
};

export type VerifyRunTokenOptions = {
  secret?: string;
  now?: Date;
  expected?: Partial<RunTokenBinding>;
};

export type VerifyRunTokenResult =
  | { ok: true; claims: RunTokenClaims }
  | {
      ok: false;
      reason:
        | "missing_secret"
        | "malformed"
        | "signature_invalid"
        | "expired"
        | "binding_mismatch";
    };

const DEFAULT_TTL_SECONDS = 60 * 60;
const TOKEN_PREFIX = "caprt";

export function issueRunToken(options: IssueRunTokenOptions): string {
  const secret = options.secret ?? getRunTokenSecret();
  if (!secret) {
    throw new Error("RUN_TOKEN_SECRET or BETTER_AUTH_SECRET is required");
  }

  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("ttlSeconds must be a positive integer");
  }

  const issuedAt = toUnixSeconds(options.now ?? new Date());
  const claims: RunTokenClaims = {
    typ: RUN_TOKEN_TYPE,
    userId: options.userId,
    workspaceId: options.workspaceId,
    threadId: options.threadId,
    runId: options.runId,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
  };

  const payload = base64urlEncode(JSON.stringify(claims));
  const signature = sign(payload, secret);
  return `${TOKEN_PREFIX}.${payload}.${signature}`;
}

export function verifyRunToken(
  token: string,
  options: VerifyRunTokenOptions = {},
): VerifyRunTokenResult {
  const secret = options.secret ?? getRunTokenSecret();
  if (!secret) return { ok: false, reason: "missing_secret" };

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    return { ok: false, reason: "malformed" };
  }

  const [, payload, signature] = parts;
  if (!payload || !signature) return { ok: false, reason: "malformed" };

  const expectedSignature = sign(payload, secret);
  if (!safeEqual(signature, expectedSignature)) {
    return { ok: false, reason: "signature_invalid" };
  }

  const claims = parseClaims(payload);
  if (!claims) return { ok: false, reason: "malformed" };

  const now = toUnixSeconds(options.now ?? new Date());
  if (claims.exp <= now) return { ok: false, reason: "expired" };

  if (options.expected && !matchesExpectedBinding(claims, options.expected)) {
    return { ok: false, reason: "binding_mismatch" };
  }

  return { ok: true, claims };
}

export function extractBearerRunToken(
  authorizationHeader: string | null | undefined,
): string | null {
  if (!authorizationHeader) return null;
  const [scheme, token, extra] = authorizationHeader.trim().split(/\s+/);
  if (extra || scheme !== "Bearer" || !token) return null;
  return token;
}

function getRunTokenSecret(): string | undefined {
  return process.env.RUN_TOKEN_SECRET ?? process.env.BETTER_AUTH_SECRET;
}

function matchesExpectedBinding(
  claims: RunTokenClaims,
  expected: Partial<RunTokenBinding>,
): boolean {
  return (
    (expected.userId === undefined || expected.userId === claims.userId) &&
    (expected.workspaceId === undefined ||
      expected.workspaceId === claims.workspaceId) &&
    (expected.threadId === undefined || expected.threadId === claims.threadId) &&
    (expected.runId === undefined || expected.runId === claims.runId)
  );
}

function parseClaims(payload: string): RunTokenClaims | null {
  try {
    const parsed = JSON.parse(base64urlDecode(payload)) as unknown;
    if (!isPlainObject(parsed)) return null;
    if (parsed.typ !== RUN_TOKEN_TYPE) return null;
    if (!isString(parsed.userId)) return null;
    if (!isString(parsed.workspaceId)) return null;
    if (!isString(parsed.threadId)) return null;
    if (!isString(parsed.runId)) return null;
    if (!isUnixSeconds(parsed.iat)) return null;
    if (!isUnixSeconds(parsed.exp)) return null;
    if (parsed.exp <= parsed.iat) return null;
    return {
      typ: RUN_TOKEN_TYPE,
      userId: parsed.userId,
      workspaceId: parsed.workspaceId,
      threadId: parsed.threadId,
      runId: parsed.runId,
      iat: parsed.iat,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function base64urlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64urlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isUnixSeconds(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

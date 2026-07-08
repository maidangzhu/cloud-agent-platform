import { describe, expect, it } from "vitest";
import {
  extractBearerRunToken,
  issueRunToken,
  verifyRunToken,
  type RunTokenBinding,
} from "./run-token.js";

const SECRET = "unit-test-run-token-secret";
const NOW = new Date("2026-07-05T00:00:00.000Z");
const BINDING: RunTokenBinding = {
  userId: "user_1",
  workspaceId: "workspace_1",
  threadId: "thread_1",
  runId: "run_1",
};

describe("scoped run token", () => {
  it("signs and verifies a token bound to user/workspace/thread/run", () => {
    const token = issueRunToken({
      ...BINDING,
      secret: SECRET,
      ttlSeconds: 300,
      now: NOW,
    });

    const result = verifyRunToken(token, {
      secret: SECRET,
      now: new Date("2026-07-05T00:01:00.000Z"),
      expected: BINDING,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims).toMatchObject(BINDING);
      expect(result.claims.exp - result.claims.iat).toBe(300);
    }
  });

  it("rejects expired token", () => {
    const token = issueRunToken({
      ...BINDING,
      secret: SECRET,
      ttlSeconds: 60,
      now: NOW,
    });

    expect(
      verifyRunToken(token, {
        secret: SECRET,
        now: new Date("2026-07-05T00:01:00.000Z"),
        expected: BINDING,
      }),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects token for the wrong run", () => {
    const token = issueRunToken({
      ...BINDING,
      secret: SECRET,
      ttlSeconds: 300,
      now: NOW,
    });

    expect(
      verifyRunToken(token, {
        secret: SECRET,
        now: NOW,
        expected: { ...BINDING, runId: "run_2" },
      }),
    ).toEqual({ ok: false, reason: "binding_mismatch" });
  });

  it("rejects token for the wrong workspace", () => {
    const token = issueRunToken({
      ...BINDING,
      secret: SECRET,
      ttlSeconds: 300,
      now: NOW,
    });

    expect(
      verifyRunToken(token, {
        secret: SECRET,
        now: NOW,
        expected: { ...BINDING, workspaceId: "workspace_2" },
      }),
    ).toEqual({ ok: false, reason: "binding_mismatch" });
  });

  it("rejects tampered payload", () => {
    const token = issueRunToken({
      ...BINDING,
      secret: SECRET,
      ttlSeconds: 300,
      now: NOW,
    });
    const parts = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        typ: "cap.run_token.v1",
        userId: BINDING.userId,
        workspaceId: BINDING.workspaceId,
        threadId: BINDING.threadId,
        runId: "run_2",
        iat: 0,
        exp: 9999999999,
      }),
      "utf8",
    ).toString("base64url");

    expect(
      verifyRunToken(`${parts[0]}.${tamperedPayload}.${parts[2]}`, {
        secret: SECRET,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("extracts Authorization bearer token", () => {
    expect(extractBearerRunToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(extractBearerRunToken("Basic abc")).toBeNull();
    expect(extractBearerRunToken("Bearer")).toBeNull();
    expect(extractBearerRunToken("Bearer abc extra")).toBeNull();
  });
});

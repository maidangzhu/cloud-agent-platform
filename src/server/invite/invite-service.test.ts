import { describe, expect, it } from "vitest";
import { hashCode, isValidInviteCode } from "./invite-service";

describe("isValidInviteCode", () => {
  it("有效码返回 true", () => {
    process.env.INVITE_CODES = "abc-123,xyz-456";
    expect(isValidInviteCode("abc-123")).toBe(true);
    expect(isValidInviteCode("xyz-456")).toBe(true);
  });

  it("无效码返回 false", () => {
    process.env.INVITE_CODES = "abc-123";
    expect(isValidInviteCode("wrong")).toBe(false);
    expect(isValidInviteCode("")).toBe(false);
  });

  it("trim 空格后匹配", () => {
    process.env.INVITE_CODES = " code-1 ";
    expect(isValidInviteCode("code-1")).toBe(true);
    expect(isValidInviteCode("  code-1  ")).toBe(true);
  });

  it("INVITE_CODES 未设置 → 全部无效", () => {
    delete process.env.INVITE_CODES;
    expect(isValidInviteCode("any")).toBe(false);
  });
});

describe("hashCode", () => {
  it("同一码得到相同 hash", () => {
    expect(hashCode("abc")).toBe(hashCode("abc"));
  });
  it("不同码 hash 不同", () => {
    expect(hashCode("abc")).not.toBe(hashCode("xyz"));
  });
  it("返回64位十六进制字符串", () => {
    expect(hashCode("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

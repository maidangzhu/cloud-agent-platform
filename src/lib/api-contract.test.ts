import { describe, expect, it } from "vitest";
import {
  ApiCode,
  apiJson,
  fail,
  httpStatusForCode,
  ok,
} from "./api-contract";

describe("api-contract — ok()", () => {
  it("成功信封：code 0 + data + 默认 message", () => {
    expect(ok({ id: "s1" })).toEqual({
      code: 0,
      message: "ok",
      data: { id: "s1" },
    });
  });

  it("可自定义 message", () => {
    expect(ok(null, "done").message).toBe("done");
  });
});

describe("api-contract — fail()", () => {
  it("失败信封：data 为 null，status 由 code 推导", () => {
    const r = fail(ApiCode.UNAUTHORIZED, "邀请码无效");
    expect(r.body).toEqual({ code: 1002, message: "邀请码无效", data: null });
    expect(r.status).toBe(401);
  });

  it("可显式覆盖 status", () => {
    expect(fail(ApiCode.BAD_REQUEST, "x", 422).status).toBe(422);
  });
});

describe("api-contract — httpStatusForCode()", () => {
  it.each([
    [ApiCode.OK, 200],
    [ApiCode.BAD_REQUEST, 400],
    [ApiCode.UNAUTHORIZED, 401],
    [ApiCode.NOT_FOUND, 404],
    [ApiCode.CONFLICT, 409],
    [ApiCode.RUN_NOT_CANCELABLE, 409],
    [ApiCode.WORKSPACE_FAILED, 422],
    [ApiCode.INTERNAL, 500],
  ])("code %i → http %i", (code, status) => {
    expect(httpStatusForCode(code)).toBe(status);
  });

  it("未知非零 code 兜底 500", () => {
    expect(httpStatusForCode(9999)).toBe(500);
  });
});

describe("api-contract — apiJson()", () => {
  it("产出 Web 标准 Response，body 为信封 JSON", async () => {
    const res = apiJson(ok({ a: 1 }), 200);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ code: 0, message: "ok", data: { a: 1 } });
  });
});

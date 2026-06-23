import { describe, expect, it } from "vitest";
import { isWithinRoot, resolveWithinRoot } from "./path-guard";

const ROOT = "/work/ws";

describe("path-guard — 合法放行", () => {
  it("相对路径解析到 root 内", () => {
    expect(resolveWithinRoot(ROOT, "a/b.txt")).toBe("/work/ws/a/b.txt");
    expect(isWithinRoot(ROOT, "a/b.txt")).toBe(true);
  });

  it("`./` 前缀与中间 `..` 抵消后仍在 root 内", () => {
    expect(resolveWithinRoot(ROOT, "./a/b.txt")).toBe("/work/ws/a/b.txt");
    expect(resolveWithinRoot(ROOT, "a/../b.txt")).toBe("/work/ws/b.txt");
    expect(isWithinRoot(ROOT, "a/x/../../b.txt")).toBe(true);
  });

  it("`.` 解析为 root 自身", () => {
    expect(resolveWithinRoot(ROOT, ".")).toBe("/work/ws");
    expect(isWithinRoot(ROOT, ".")).toBe(true);
  });

  it("已在 root 内的绝对路径放行", () => {
    expect(isWithinRoot(ROOT, "/work/ws/sub/f.txt")).toBe(true);
    expect(resolveWithinRoot(ROOT, "/work/ws/sub/f.txt")).toBe(
      "/work/ws/sub/f.txt",
    );
  });
});

describe("path-guard — 越权拒绝", () => {
  it("相对 `..` 逃逸被拒", () => {
    expect(isWithinRoot(ROOT, "../escape.txt")).toBe(false);
    expect(() => resolveWithinRoot(ROOT, "../escape.txt")).toThrow();
  });

  it("深层 `..` 逃逸被拒", () => {
    expect(isWithinRoot(ROOT, "a/../../../etc/passwd")).toBe(false);
    expect(() => resolveWithinRoot(ROOT, "a/../../../etc/passwd")).toThrow();
  });

  it("root 外的绝对路径被拒", () => {
    expect(isWithinRoot(ROOT, "/etc/passwd")).toBe(false);
    expect(() => resolveWithinRoot(ROOT, "/etc/passwd")).toThrow();
  });

  it("前缀相同但不同目录的绝对路径被拒（/work/ws-evil）", () => {
    expect(isWithinRoot(ROOT, "/work/ws-evil/f.txt")).toBe(false);
    expect(() => resolveWithinRoot(ROOT, "/work/ws-evil/f.txt")).toThrow();
  });

  it("错误信息包含越权的路径", () => {
    expect(() => resolveWithinRoot(ROOT, "../escape.txt")).toThrow(/escape\.txt/);
  });

  it("空路径被拒（无目标）", () => {
    expect(() => resolveWithinRoot(ROOT, "")).toThrow();
    expect(isWithinRoot(ROOT, "")).toBe(false);
  });
});

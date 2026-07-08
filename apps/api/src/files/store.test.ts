import { describe, expect, it } from "vitest";
import {
  MAX_INLINE_FILE_CONTENT_BYTES,
  computeContentHash,
  normalizeWorkspacePath,
  validateWorkspaceFileInput,
} from "./store.js";

describe("workspace file store helpers", () => {
  it("path guard rejects path traversal and absolute paths", () => {
    expect(normalizeWorkspacePath("../secret.txt").ok).toBe(false);
    expect(normalizeWorkspacePath("/etc/passwd").ok).toBe(false);
    expect(normalizeWorkspacePath("notes/../../secret.txt").ok).toBe(false);
  });

  it("path guard normalizes valid relative paths", () => {
    expect(normalizeWorkspacePath("./notes//research.md")).toEqual({
      ok: true,
      path: "notes/research.md",
    });
    expect(normalizeWorkspacePath("notes/draft/../final.md")).toEqual({
      ok: true,
      path: "notes/final.md",
    });
  });

  it("content hash is computed consistently for same content", () => {
    expect(computeContentHash("hello")).toBe(computeContentHash("hello"));
    expect(computeContentHash("hello")).not.toBe(computeContentHash("world"));
    expect(computeContentHash("hello")).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("content size policy rejects oversized inline content without storageKey", () => {
    const content = "x".repeat(MAX_INLINE_FILE_CONTENT_BYTES + 1);
    const rejected = validateWorkspaceFileInput({
      path: "notes/large.txt",
      kind: "text",
      size: Buffer.byteLength(content, "utf8"),
      contentHash: computeContentHash(content),
      content,
    });
    expect(rejected.ok).toBe(false);

    const accepted = validateWorkspaceFileInput({
      path: "notes/large.txt",
      kind: "text",
      size: Buffer.byteLength(content, "utf8"),
      contentHash: computeContentHash(content),
      content,
      storageKey: "workspace/files/large.txt",
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.input.content).toBeUndefined();
      expect(accepted.input.storageKey).toBe("workspace/files/large.txt");
    }
  });
});

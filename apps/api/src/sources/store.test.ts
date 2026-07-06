import { describe, expect, it } from "vitest";
import { normalizeSourceUrl, validateSourceInput } from "./store";

describe("source store helpers", () => {
  it("validates source kind", () => {
    expect(validateSourceInput({ kind: "url", uri: "https://example.com" }).ok).toBe(
      true,
    );
    expect(validateSourceInput({ kind: "file" }).ok).toBe(true);
    expect(validateSourceInput({ kind: "nonsense" }).ok).toBe(false);
  });

  it("normalizes URL protocol, hostname, and trailing slash", () => {
    expect(normalizeSourceUrl("HTTPS://Example.COM/path/")).toBe(
      "https://example.com/path",
    );
    expect(normalizeSourceUrl("https://Example.com/")).toBe(
      "https://example.com",
    );
  });
});

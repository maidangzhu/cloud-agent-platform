import { describe, expect, it } from "vitest";
import { deriveThreadTitle } from "./title.js";

// docs/testing-strategy.md §4.3 unit 1-2
describe("deriveThreadTitle", () => {
  it("derive title from prompt when title omitted", () => {
    expect(deriveThreadTitle(undefined, "explain quantum computing")).toBe(
      "explain quantum computing",
    );
  });

  it("derive title falls back to default when prompt empty", () => {
    expect(deriveThreadTitle(undefined, undefined)).toBe("New thread");
    expect(deriveThreadTitle("", "")).toBe("New thread");
    expect(deriveThreadTitle("   ", "   ")).toBe("New thread");
  });

  it("prefers explicit title over initialPrompt", () => {
    expect(deriveThreadTitle("My Title", "some prompt")).toBe("My Title");
  });

  it("truncates long titles to 100 chars", () => {
    const long = "a".repeat(150);
    expect(deriveThreadTitle(long, undefined).length).toBe(100);
  });
});

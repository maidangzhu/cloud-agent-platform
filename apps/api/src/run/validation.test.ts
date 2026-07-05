import { describe, expect, it } from "vitest";
import { validateRunPrompt } from "./validation";

describe("validateRunPrompt", () => {
  it("rejects empty string", () => {
    expect(validateRunPrompt("")).not.toBeNull();
  });

  it("rejects whitespace-only string", () => {
    expect(validateRunPrompt("   ")).not.toBeNull();
  });

  it("accepts non-empty trimmed string", () => {
    expect(validateRunPrompt("summarize this paper")).toBeNull();
  });
});

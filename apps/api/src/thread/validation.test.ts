import { describe, expect, it } from "vitest";
import { validateThreadTitle } from "./validation";

describe("validateThreadTitle", () => {
  it("rejects empty string", () => {
    expect(validateThreadTitle("")).not.toBeNull();
  });

  it("rejects whitespace-only string", () => {
    expect(validateThreadTitle("   ")).not.toBeNull();
  });

  it("accepts non-empty trimmed string", () => {
    expect(validateThreadTitle("Renamed Thread")).toBeNull();
  });
});

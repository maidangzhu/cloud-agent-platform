import { describe, expect, it } from "vitest";
import { validateWorkspaceTitle } from "./validation";

// docs/testing-strategy.md §4.2 unit 1-3
describe("validateWorkspaceTitle", () => {
  it("rejects empty string", () => {
    expect(validateWorkspaceTitle("")).not.toBeNull();
  });

  it("rejects whitespace-only string", () => {
    expect(validateWorkspaceTitle("   ")).not.toBeNull();
  });

  it("accepts non-empty trimmed string", () => {
    expect(validateWorkspaceTitle("My Research")).toBeNull();
  });
});

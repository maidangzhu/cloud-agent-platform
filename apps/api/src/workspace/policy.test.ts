import { describe, expect, it } from "vitest";
import { canCreateInWorkspace, canReadWorkspace } from "./policy";

// docs/testing-strategy.md §4.2 unit 4-5
describe("workspace archive policy", () => {
  it("archived workspace blocks new thread/run creation", () => {
    expect(canCreateInWorkspace("archived")).toBe(false);
  });

  it("active workspace allows creation", () => {
    expect(canCreateInWorkspace("active")).toBe(true);
  });

  it("archived workspace still readable", () => {
    expect(canReadWorkspace("archived")).toBe(true);
  });
});

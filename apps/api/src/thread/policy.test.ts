import { describe, expect, it } from "vitest";
import { canReadThread, canStartRunInThread } from "./policy";

// docs/testing-strategy.md §4.3 unit 3-4
describe("thread archive policy", () => {
  it("archived thread blocks new run creation", () => {
    expect(canStartRunInThread("archived")).toBe(false);
  });

  it("active thread allows run creation", () => {
    expect(canStartRunInThread("active")).toBe(true);
  });

  it("archived thread still readable", () => {
    expect(canReadThread("archived")).toBe(true);
  });
});

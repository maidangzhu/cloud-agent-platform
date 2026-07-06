import { describe, expect, it } from "vitest";
import {
  allocateArtifactVersion,
  hasRecoverableArtifactContent,
  validateArtifactInput,
} from "./store";

describe("artifact store helpers", () => {
  it("artifact validation requires title and kind", () => {
    expect(
      validateArtifactInput({
        kind: "text",
        contentSnapshot: "body",
      }).ok,
    ).toBe(false);
    expect(
      validateArtifactInput({
        title: "Report",
        contentSnapshot: "body",
      }).ok,
    ).toBe(false);
  });

  it("artifact validation requires recoverable content", () => {
    const invalid = validateArtifactInput({
      title: "Report",
      kind: "text",
    });
    expect(invalid.ok).toBe(false);

    const withSnapshot = validateArtifactInput({
      title: "Report",
      kind: "text",
      contentSnapshot: "body",
    });
    expect(withSnapshot.ok).toBe(true);

    const withStorageKey = validateArtifactInput({
      title: "Report",
      kind: "text",
      storageKey: "artifacts/report.md",
    });
    expect(withStorageKey.ok).toBe(true);

    const withPath = validateArtifactInput({
      title: "Report",
      kind: "text",
      path: "notes/report.md",
    });
    expect(withPath.ok).toBe(true);
  });

  it("content snapshot requirement rejects artifact with no snapshot, storageKey, or path", () => {
    expect(hasRecoverableArtifactContent({})).toBe(false);
    expect(hasRecoverableArtifactContent({ contentSnapshot: "body" })).toBe(
      true,
    );
    expect(hasRecoverableArtifactContent({ storageKey: "artifact/report" })).toBe(
      true,
    );
    expect(hasRecoverableArtifactContent({ path: "notes/report.md" })).toBe(
      true,
    );
  });

  it("version allocation gives version 1 for missing artifact", () => {
    expect(allocateArtifactVersion(null)).toBe(1);
  });

  it("version allocation increments existing artifact version", () => {
    expect(allocateArtifactVersion(1)).toBe(2);
    expect(allocateArtifactVersion(7)).toBe(8);
  });
});

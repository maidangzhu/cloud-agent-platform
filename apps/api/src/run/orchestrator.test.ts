import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_ORCHESTRATOR_API_BASE_URL,
  resolveRunOrchestratorApiBaseUrl,
} from "./orchestrator.js";

const API_BASE_ENV_KEYS = [
  "PUBLIC_AGENT_LOOP_BASE_URL",
  "CAP_API_BASE_URL",
  "INGEST_BASE_URL",
  "API_BASE_URL",
  "PUBLIC_API_BASE_URL",
  "PUBLIC_INGEST_BASE_URL",
  "BETTER_AUTH_URL",
  "CAP_ALLOW_LOCAL_RUNNER_BASE_URL",
] as const;

const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of API_BASE_ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of API_BASE_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
});

describe("resolveRunOrchestratorApiBaseUrl", () => {
  it("uses the hosted Control Plane by default during local development", () => {
    process.env.BETTER_AUTH_URL = "http://localhost:8787";

    expect(resolveRunOrchestratorApiBaseUrl()).toBe(
      DEFAULT_RUN_ORCHESTRATOR_API_BASE_URL,
    );
  });

  it("allows a hosted Control Plane override", () => {
    process.env.PUBLIC_AGENT_LOOP_BASE_URL = "https://api-preview.example.com/";

    expect(resolveRunOrchestratorApiBaseUrl()).toBe(
      "https://api-preview.example.com",
    );
  });

  it("uses the first configured public URL", () => {
    process.env.PUBLIC_AGENT_LOOP_BASE_URL = "http://localhost:8787";
    process.env.CAP_API_BASE_URL = "https://api-preview.example.com/";

    expect(resolveRunOrchestratorApiBaseUrl()).toBe(
      "https://api-preview.example.com",
    );
  });

  it("ignores local and invalid overrides", () => {
    process.env.PUBLIC_AGENT_LOOP_BASE_URL = "not-a-url";
    process.env.CAP_API_BASE_URL = "http://127.0.0.1:8787";
    process.env.CAP_ALLOW_LOCAL_RUNNER_BASE_URL = "true";

    expect(resolveRunOrchestratorApiBaseUrl()).toBe(
      DEFAULT_RUN_ORCHESTRATOR_API_BASE_URL,
    );
  });
});

import { describe, expect, it } from "vitest";
import { PI_RUNTIME_SANDBOX_SCRIPT } from "./sandbox-script.js";

describe("Pi runtime sandbox script protocol", () => {
  it("preserves assistant tool calls and tool result linkage between LLM turns", () => {
    expect(PI_RUNTIME_SANDBOX_SCRIPT).toContain("...(toolCalls.length > 0 ? { toolCalls } : {})");
    expect(PI_RUNTIME_SANDBOX_SCRIPT).toContain("toolCallId: message.toolCallId");
    expect(PI_RUNTIME_SANDBOX_SCRIPT).toContain("toolName: message.toolName");
  });

  it("fails the run when Pi reports an LLM error before completion", () => {
    const promptIndex = PI_RUNTIME_SANDBOX_SCRIPT.indexOf("await agent.prompt(config.prompt)");
    const failureCheckIndex = PI_RUNTIME_SANDBOX_SCRIPT.indexOf("throwIfAgentFailed(agent)", promptIndex);
    const completionIndex = PI_RUNTIME_SANDBOX_SCRIPT.indexOf('await postRunEvent("run_completed"');

    expect(promptIndex).toBeGreaterThanOrEqual(0);
    expect(failureCheckIndex).toBeGreaterThan(promptIndex);
    expect(completionIndex).toBeGreaterThan(failureCheckIndex);
  });

  it("uses text parts only for the final assistant message", () => {
    expect(PI_RUNTIME_SANDBOX_SCRIPT).toContain("assistantTextContent(message.content)");
    expect(PI_RUNTIME_SANDBOX_SCRIPT).toContain('.filter((part) => part.type === "text")');
    expect(PI_RUNTIME_SANDBOX_SCRIPT).not.toContain(
      "latestAssistantContent || (assistant ? stringifyContent(assistant.content) : \"\")",
    );
  });

  it("keeps LLM proxy calls bounded and asks tools for machine-readable output", () => {
    expect(PI_RUNTIME_SANDBOX_SCRIPT).toContain("LLM_PROXY_TIMEOUT_MS");
    expect(PI_RUNTIME_SANDBOX_SCRIPT).toContain("signal: llmProxySignal");
    expect(PI_RUNTIME_SANDBOX_SCRIPT).toContain(
      "Prefer machine-readable output such as --json",
    );
    expect(PI_RUNTIME_SANDBOX_SCRIPT).toContain(
      "Avoid interactive commands that wait for terminal input",
    );
  });
});

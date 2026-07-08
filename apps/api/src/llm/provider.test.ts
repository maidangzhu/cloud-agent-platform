import { describe, expect, it } from "vitest";
import {
  completeWithRealProvider,
  fakeComplete,
  normalizeFinishReason,
  normalizeOpenAiChatCompletion,
  resolveLlmModelChain,
  type LlmHttpTransport,
} from "./provider.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("LLM provider config resolution", () => {
  it("resolves modelHint-specific model before default model", () => {
    const resolved = resolveLlmModelChain({
      modelHint: "research-default",
      env: {
        OPENAI_API_KEY: "k1",
        OPENAI_BASE_URL: "https://relay.example/v1",
        LLM_MODEL: "fallback-default",
        LLM_MODEL_RESEARCH_DEFAULT: "research-model",
      },
    });

    expect(resolved).toEqual({
      ok: true,
      chain: [
        {
          key: "ch1-primary",
          channel: 1,
          tier: "primary",
          provider: "openai-compatible",
          model: "research-model",
          baseUrl: "https://relay.example/v1",
          apiKey: "k1",
        },
      ],
    });
  });

  it("returns clear config error when provider key is missing", () => {
    const resolved = resolveLlmModelChain({
      env: {
        OPENAI_BASE_URL: "https://relay.example/v1",
        LLM_MODEL: "research-model",
      },
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok === false) {
      expect(resolved.message).toMatch(/OPENAI_API_KEY/);
    }
  });

  it("builds primary/fallback chain across configured channels", () => {
    const resolved = resolveLlmModelChain({
      env: {
        OPENAI_API_KEY: "k1",
        OPENAI_BASE_URL: "https://relay1.example/v1",
        LLM_MODEL: "m1",
        LLM_MODEL_FALLBACK: "m1-fallback",
        OPENAI_API_KEY2: "k2",
        OPENAI_BASE_URL2: "https://relay2.example/v1",
        LLM_MODEL2: "m2",
      },
    });

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.chain.map((entry) => entry.key)).toEqual([
        "ch1-primary",
        "ch1-fallback",
        "ch2-primary",
      ]);
    }
  });
});

describe("finishReason normalization", () => {
  it("maps provider-specific finish signals to stable internal values", () => {
    expect(normalizeFinishReason("stop")).toBe("stop");
    expect(normalizeFinishReason("end_turn")).toBe("stop");
    expect(normalizeFinishReason("max_tokens")).toBe("length");
    expect(normalizeFinishReason("tool_use")).toBe("tool_calls");
    expect(normalizeFinishReason("function_call")).toBe("tool_calls");
    expect(normalizeFinishReason("safety")).toBe("content_filter");
    expect(normalizeFinishReason(undefined)).toBe("unknown");
  });
});

describe("fake provider agent-loop fixture", () => {
  it("returns complete write_file/create_artifact tool calls for Step 16 agent loop", () => {
    const result = fakeComplete(
      [{ role: "user", content: "produce report" }],
      "agent-loop-step16",
    );

    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls.map((toolCall) => toolCall.name)).toEqual([
      "write_file",
      "create_artifact",
    ]);
    expect(JSON.parse(result.toolCalls[0]?.arguments ?? "{}")).toMatchObject({
      path: "reports/agent-loop-report.md",
      mimeType: "text/markdown",
    });
    expect(JSON.parse(result.toolCalls[1]?.arguments ?? "{}")).toMatchObject({
      title: "Agent Loop Report",
      kind: "text",
      path: "reports/agent-loop-report.md",
    });
  });

  it("stops Step 16 fake tool calls after tool results are present", () => {
    const result = fakeComplete(
      [
        { role: "user", content: "produce report" },
        { role: "tool", content: "Wrote reports/agent-loop-report.md" },
      ],
      "agent-loop-step16",
    );

    expect(result.finishReason).toBe("stop");
    expect(result.toolCalls).toEqual([]);
    expect(result.content).toContain("produce report");
  });
});

describe("OpenAI-compatible response normalization", () => {
  const entry = { model: "configured-model" };

  it("normalizes response with thinking and content", () => {
    const normalized = normalizeOpenAiChatCompletion(
      {
        model: "actual-model",
        choices: [
          {
            finish_reason: "stop",
            message: {
              reasoning_content: "think first",
              content: "answer",
            },
          },
        ],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 5,
          total_tokens: 8,
        },
      },
      entry,
    );

    expect(normalized).toMatchObject({
      provider: "openai-compatible",
      model: "actual-model",
      reasoning: "think first",
      content: "answer",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
    });
  });

  it("normalizes response without thinking", () => {
    const normalized = normalizeOpenAiChatCompletion(
      {
        choices: [
          {
            finish_reason: "stop",
            message: { content: "plain answer" },
          },
        ],
      },
      entry,
    );

    expect(normalized.reasoning).toBe("");
    expect(normalized.content).toBe("plain answer");
    expect(normalized.finishReason).toBe("stop");
  });

  it("normalizes tool calls as complete objects, not text chunks", () => {
    const normalized = normalizeOpenAiChatCompletion(
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  function: {
                    name: "web_search",
                    arguments: "{\"query\":\"redis streams\"}",
                  },
                },
              ],
            },
          },
        ],
      },
      entry,
    );

    expect(normalized.content).toBe("");
    expect(normalized.toolCalls).toEqual([
      {
        id: "call_1",
        name: "web_search",
        arguments: "{\"query\":\"redis streams\"}",
      },
    ]);
    expect(normalized.finishReason).toBe("tool_calls");
  });
});

describe("real provider retry/fallback/timeout shell", () => {
  const env = {
    OPENAI_API_KEY: "k1",
    OPENAI_BASE_URL: "https://relay1.example/v1",
    LLM_MODEL: "m1",
    OPENAI_API_KEY2: "k2",
    OPENAI_BASE_URL2: "https://relay2.example/v1",
    LLM_MODEL2: "m2",
  };

  it("retries once before succeeding and records attempt durations", async () => {
    let calls = 0;
    const transport: LlmHttpTransport = async () => {
      calls += 1;
      if (calls === 1) return response({ error: "temporary" }, 503);
      return response({
        model: "m1",
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
      });
    };

    const result = await completeWithRealProvider({
      messages: [{ role: "user", content: "hello" }],
      env,
      transport,
      maxRetries: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.content).toBe("ok");
      expect(result.result.attempts.map((attempt) => attempt.outcome)).toEqual([
        "retry",
        "success",
      ]);
      expect(result.result.attempts[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(result.result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("falls back to next channel after retry exhaustion", async () => {
    const seenUrls: string[] = [];
    const transport: LlmHttpTransport = async (url) => {
      seenUrls.push(url);
      if (url.startsWith("https://relay1.example")) {
        return response({ error: "down" }, 503);
      }
      return response({
        model: "m2",
        choices: [{ finish_reason: "stop", message: { content: "fallback ok" } }],
      });
    };

    const result = await completeWithRealProvider({
      messages: [{ role: "user", content: "hello" }],
      env,
      transport,
      maxRetries: 0,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.model).toBe("m2");
      expect(result.result.attempts.map((attempt) => attempt.key)).toEqual([
        "ch1-primary",
        "ch2-primary",
      ]);
      expect(seenUrls).toEqual([
        "https://relay1.example/v1/chat/completions",
        "https://relay2.example/v1/chat/completions",
      ]);
    }
  });

  it("normalizes Pi-style tools to OpenAI function tools before provider calls", async () => {
    let requestBody: Record<string, unknown> = {};
    const transport: LlmHttpTransport = async (_url, init) => {
      requestBody = JSON.parse(String(init.body));
      return response({
        model: "m1",
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
      });
    };

    const result = await completeWithRealProvider({
      messages: [{ role: "user", content: "write a file" }],
      tools: [
        {
          name: "write_file",
          description: "Write a workspace file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
      env,
      transport,
      maxRetries: 0,
    });

    expect(result.ok).toBe(true);
    expect(requestBody.tools).toEqual([
      {
        type: "function",
        function: {
          name: "write_file",
          description: "Write a workspace file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ]);
  });

  it("preserves already normalized OpenAI function tools", async () => {
    let requestBody: Record<string, unknown> = {};
    const transport: LlmHttpTransport = async (_url, init) => {
      requestBody = JSON.parse(String(init.body));
      return response({
        model: "m1",
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
      });
    };

    const normalizedTool = {
      type: "function",
      function: {
        name: "create_artifact",
        description: "Create an artifact.",
        parameters: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
      },
    };

    const result = await completeWithRealProvider({
      messages: [{ role: "user", content: "create artifact" }],
      tools: [normalizedTool],
      env,
      transport,
      maxRetries: 0,
    });

    expect(result.ok).toBe(true);
    expect(requestBody.tools).toEqual([normalizedTool]);
  });

  it("times out a hanging provider attempt and retries", async () => {
    let calls = 0;
    const transport: LlmHttpTransport = async (_url, init) => {
      calls += 1;
      if (calls === 1) {
        await new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      }
      return response({
        model: "m1",
        choices: [{ finish_reason: "stop", message: { content: "after timeout" } }],
      });
    };

    const result = await completeWithRealProvider({
      messages: [{ role: "user", content: "hello" }],
      env,
      transport,
      timeoutMs: 1,
      maxRetries: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.content).toBe("after timeout");
      expect(result.result.attempts[0].error).toMatch(/timeout/);
      expect(result.result.attempts.map((attempt) => attempt.outcome)).toEqual([
        "retry",
        "success",
      ]);
    }
  });
});

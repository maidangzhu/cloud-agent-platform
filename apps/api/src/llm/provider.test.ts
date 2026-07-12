import { describe, expect, it, vi } from "vitest";
import {
  completeWithRealProvider,
  fakeComplete,
  normalizeFinishReason,
  normalizeOpenAiChatCompletion,
  resolveLlmModelChain,
  streamWithRealProvider,
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

  it("routes a model hint through the server-owned provider channel", () => {
    const resolved = resolveLlmModelChain({
      modelHint: "pi-runtime",
      env: {
        OPENAI_API_KEY: "k1",
        OPENAI_BASE_URL: "https://relay1.example/v1",
        LLM_MODEL: "m1",
        OPENAI_API_KEY2: "k2",
        OPENAI_BASE_URL2: "https://relay2.example/v1",
        LLM_MODEL2: "m2",
        LLM_CHANNEL_PI_RUNTIME: "2",
      },
    });

    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.chain.map((entry) => entry.key)).toEqual(["ch2-primary"]);
      expect(resolved.chain[0]?.model).toBe("m2");
    }
  });

  it("rejects an invalid model-hint channel", () => {
    const resolved = resolveLlmModelChain({
      modelHint: "pi-runtime",
      env: { LLM_CHANNEL_PI_RUNTIME: "99" },
    });

    expect(resolved).toEqual({
      ok: false,
      message: "LLM_CHANNEL_PI_RUNTIME must be an integer between 1 and 20",
    });
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

	  it("returns complete filesystem and command tool calls for Pi runtime tool smoke", () => {
	    const result = fakeComplete(
	      [{ role: "user", content: "execute a command" }],
	      "pi-runtime-tools",
	    );

	    expect(result.finishReason).toBe("tool_calls");
	    expect(result.toolCalls.map((toolCall) => toolCall.name)).toEqual([
	      "run_command",
	      "list_directory",
	      "read_file",
	    ]);
	    expect(JSON.parse(result.toolCalls[0]?.arguments ?? "{}")).toMatchObject({
	      command: expect.stringContaining("maidang-smoke"),
	      timeoutMs: 5000,
	    });
	    expect(JSON.parse(result.toolCalls[2]?.arguments ?? "{}")).toMatchObject({
	      path: "command-output.txt",
	    });
	  });

  it("returns a complete web_search tool call for Pi runtime search smoke", () => {
    const result = fakeComplete(
      [{ role: "user", content: "agent runtime search" }],
      "pi-runtime-search",
    );

    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls.map((toolCall) => toolCall.name)).toEqual([
      "web_search",
    ]);
    expect(JSON.parse(result.toolCalls[0]?.arguments ?? "{}")).toMatchObject({
      query: "agent runtime search",
      limit: 2,
    });
  });

  it("returns a read_file call for the workspace hydration gate", () => {
    const result = fakeComplete(
      [{ role: "user", content: "read hydrated workspace state" }],
      "pi-runtime-workspace-sync",
    );

    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls.map((toolCall) => toolCall.name)).toEqual([
      "read_file",
    ]);
    expect(JSON.parse(result.toolCalls[0]?.arguments ?? "{}")).toEqual({
      path: "notes/preloaded.md",
    });
  });

  it("returns a complete fetch_url tool call for Pi runtime fetch smoke", () => {
    const result = fakeComplete(
      [{ role: "user", content: "fetch a public page" }],
      "pi-runtime-fetch",
    );

    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls.map((toolCall) => toolCall.name)).toEqual([
      "fetch_url",
    ]);
    expect(JSON.parse(result.toolCalls[0]?.arguments ?? "{}")).toEqual({
      url: "https://example.com/",
    });
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

describe("real provider streaming", () => {
  const env = {
    OPENAI_API_KEY: "k1",
    OPENAI_BASE_URL: "https://relay1.example/v1",
    LLM_MODEL: "m1",
  };

  it("emits provider deltas before the terminal result is available", async () => {
    const encoder = new TextEncoder();
    let releaseTerminal = () => undefined;
    let requestBody: Record<string, unknown> = {};
    const transport: LlmHttpTransport = async (_url, init) => {
      requestBody = JSON.parse(String(init.body));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            'data: {"model":"m1","choices":[{"delta":{"reasoning_content":"think "},"finish_reason":null}]}\n\n',
          ));
          releaseTerminal = () => {
            controller.enqueue(encoder.encode(
              'data: {"model":"m1","choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\n',
            ));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          };
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const deltas: Array<{
      provider: string;
      model: string;
      part: string;
      text: string;
    }> = [];
    let settled = false;

    const resultPromise = streamWithRealProvider({
      messages: [{ role: "user", content: "hello" }],
      env,
      transport,
      maxRetries: 0,
      reasoningEffort: "medium",
      onDelta: async (delta) => {
        deltas.push(delta);
      },
    }).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(deltas).toEqual([
      {
        provider: "openai-compatible",
        model: "m1",
        part: "reason",
        text: "think ",
      },
    ]));
    expect(settled).toBe(false);
    releaseTerminal();

    const result = await resultPromise;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toMatchObject({
        model: "m1",
        reasoning: "think ",
        content: "answer",
        finishReason: "stop",
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      });
      expect(result.result.ttfbMs).toBeGreaterThanOrEqual(0);
    }
    expect(deltas).toEqual([
      {
        provider: "openai-compatible",
        model: "m1",
        part: "reason",
        text: "think ",
      },
      {
        provider: "openai-compatible",
        model: "m1",
        part: "content",
        text: "answer",
      },
    ]);
    expect(requestBody).toMatchObject({
      model: "m1",
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: "medium",
    });
  });

  it("accumulates split tool call arguments", async () => {
    const encoder = new TextEncoder();
    const transport: LlmHttpTransport = async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode([
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tool_1","function":{"name":"write_file","arguments":"{\\\"path\\\":"}}]},"finish_reason":null}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\\"report.md\\\"}"}}]},"finish_reason":"tool_calls"}]}',
            "data: [DONE]",
            "",
          ].join("\n\n")));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

    const result = await streamWithRealProvider({
      messages: [{ role: "user", content: "write" }],
      env,
      transport,
      maxRetries: 0,
      onDelta: () => undefined,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.toolCalls).toEqual([{
        id: "tool_1",
        name: "write_file",
        arguments: '{"path":"report.md"}',
      }]);
      expect(result.result.finishReason).toBe("tool_calls");
    }
  });

  it("fails a stream that ends after a delta without a terminal event", async () => {
    const transport: LlmHttpTransport = async () => new Response(
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

    const result = await streamWithRealProvider({
      messages: [{ role: "user", content: "hello" }],
      env,
      transport,
      maxRetries: 0,
      onDelta: () => undefined,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 502,
      message: "LLM provider stream ended before a terminal event",
    });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { buildPiRuntimeStartConfig } from "./config.js";
import { PiRuntimeControlPlaneClient, type PiRuntimeTransport } from "./control-plane-client.js";
import {
  createLlmProxyStreamFn,
  createPiRuntimeAdapterTools,
} from "./adapters.js";

type RecordedCall = {
  url: string;
  body: Record<string, unknown>;
  authorization?: string;
};

const config = buildPiRuntimeStartConfig({
  apiBaseUrl: "https://api.sandbox.maidang.me",
  runToken: "run-token",
  run: {
    id: "run_1",
    workspaceId: "workspace_1",
    threadId: "thread_1",
    userId: "user_1",
    prompt: "Research adapter behavior",
    maxDurationSec: 120,
  },
});

const model: Model<"openai-completions"> = {
  id: "cap-llm-proxy",
  name: "Control Plane LLM Proxy",
  api: "openai-completions",
  provider: "cap-control-plane",
  baseUrl: config.llmProxyUrl,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Pi runtime Control Plane adapters", () => {
  it("wraps /api/llm-proxy as a Pi AssistantMessageEventStream", async () => {
    const { calls, transport } = recordingTransport((url) => {
      if (url.endsWith("/api/llm-proxy")) {
        return ok({
          provider: "fake",
          model: "fake-pi-runtime",
          output: {
            role: "assistant",
            reasoning: "think",
            content: "answer",
            toolCalls: [
              {
                id: "tool_1",
                name: "write_file",
                arguments: JSON.stringify({ path: "report.md", content: "x" }),
              },
            ],
          },
          finishReason: "tool_calls",
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        });
      }
      if (url.endsWith("/api/ingest/stream-chunk")) {
        return ok({ streamEntryId: "stream_1" });
      }
      return error(404, "unexpected path");
    });
    const client = new PiRuntimeControlPlaneClient({ config, transport });
    const streamFn = createLlmProxyStreamFn(client, "fake");

    const stream = await streamFn(model, {
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      tools: [],
    });
    const events = [];
    for await (const event of stream) events.push(event.type);
    const message = await stream.result();

    expect(message.stopReason).toBe("toolUse");
    expect(message.content.map((part) => part.type)).toEqual([
      "thinking",
      "text",
      "toolCall",
    ]);
    expect(events).toContain("done");
    expect(calls[0].url).toBe(config.llmProxyUrl);
    expect(calls[0].authorization).toBe("Bearer run-token");
    expect(calls[0].body).toMatchObject({
      runId: "run_1",
      provider: "fake",
      stream: false,
      modelHint: "cap-llm-proxy",
    });
    expect(calls.filter((call) => call.url.endsWith("/api/ingest/stream-chunk"))).toHaveLength(2);
  });

  it("routes web_search through the hosted search proxy and records tool status", async () => {
    const { calls, transport } = recordingTransport((url) => {
      if (url.endsWith("/api/ingest/tool-calls")) return ok({ toolCall: {} });
      if (url.endsWith("/api/search-proxy")) {
        return ok({
          results: [{ title: "Example", url: "https://example.com" }],
          provider: "fake",
        });
      }
      return error(404, "unexpected path");
    });
    const client = new PiRuntimeControlPlaneClient({ config, transport });
    const tool = createPiRuntimeAdapterTools(client, "fake").find(
      (item) => item.name === "web_search",
    );

    const result = await tool?.execute("tool_search_1", {
      query: "cap",
      limit: 2,
    });

    expect(result?.details).toMatchObject({
      provider: "fake",
      results: [{ title: "Example", url: "https://example.com" }],
    });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/ingest/tool-calls",
      "/api/search-proxy",
      "/api/ingest/tool-calls",
    ]);
    expect(calls[0].body).toMatchObject({
      id: "tool_search_1",
      eventSeq: 1,
      status: "running",
    });
    expect(calls[2].body).toMatchObject({
      id: "tool_search_1",
      eventSeq: 1,
      status: "completed",
    });
  });

  it("writes files through ingest files plus file_written event", async () => {
    const { calls, transport } = recordingTransport((url) => {
      if (url.endsWith("/api/ingest/tool-calls")) return ok({ toolCall: {} });
      if (url.endsWith("/api/ingest/files")) {
        return ok({
          file: {
            id: "file_1",
            path: "reports/a.md",
            size: 5,
            contentHash: "sha256:test",
          },
        });
      }
      if (url.endsWith("/api/ingest/events")) return ok({ eventId: "event_1" });
      return error(404, "unexpected path");
    });
    const client = new PiRuntimeControlPlaneClient({ config, transport });
    const tool = createPiRuntimeAdapterTools(client).find(
      (item) => item.name === "write_file",
    );

    const result = await tool?.execute("tool_file_1", {
      path: "reports/a.md",
      content: "hello",
      mimeType: "text/markdown",
    });

    expect(result?.details).toMatchObject({ id: "file_1", path: "reports/a.md" });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/ingest/tool-calls",
      "/api/ingest/files",
      "/api/ingest/events",
      "/api/ingest/tool-calls",
    ]);
    expect(calls[1].body).toMatchObject({
      path: "reports/a.md",
      kind: "text",
      size: 5,
      content: "hello",
    });
    expect(calls[2].body).toMatchObject({
      seq: 1,
      type: "file_written",
      payload: { fileId: "file_1", path: "reports/a.md" },
    });
  });

  it("creates artifacts through ingest artifacts with the current event seq", async () => {
    const { calls, transport } = recordingTransport((url) => {
      if (url.endsWith("/api/ingest/tool-calls")) return ok({ toolCall: {} });
      if (url.endsWith("/api/ingest/artifacts")) {
        return ok({
          artifact: {
            id: "artifact_1",
            title: "Report",
            kind: "text",
            version: 1,
          },
        });
      }
      return error(404, "unexpected path");
    });
    const client = new PiRuntimeControlPlaneClient({ config, transport });
    const tool = createPiRuntimeAdapterTools(client).find(
      (item) => item.name === "create_artifact",
    );

    const result = await tool?.execute("tool_artifact_1", {
      title: "Report",
      kind: "text",
      path: "reports/a.md",
    });

    expect(result?.details).toMatchObject({ id: "artifact_1", title: "Report" });
    expect(calls[1].url).toBe(`${config.ingestUrl}/artifacts`);
    expect(calls[1].body).toMatchObject({
      eventSeq: 1,
      title: "Report",
      kind: "text",
      path: "reports/a.md",
    });
  });

  it("constrains artifact kind in the tool schema", () => {
    const client = new PiRuntimeControlPlaneClient({ config });
    const tool = createPiRuntimeAdapterTools(client).find(
      (item) => item.name === "create_artifact",
    );
    const parameters = tool?.parameters as {
      properties?: { kind?: { enum?: string[] } };
    };

    expect(parameters.properties?.kind?.enum).toEqual([
      "text",
      "code",
      "sheet",
      "image",
    ]);
  });

  it("runs fetch_url through the local SSRF-guarded fetch tool", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<title>Example</title>Hello", {
        status: 200,
        headers: { "content-type": "text/html" },
      })),
    );
    const { calls, transport } = recordingTransport((url) => {
      if (url.endsWith("/api/ingest/tool-calls")) return ok({ toolCall: {} });
      return error(404, "unexpected path");
    });
    const client = new PiRuntimeControlPlaneClient({ config, transport });
    const tool = createPiRuntimeAdapterTools(client).find(
      (item) => item.name === "fetch_url",
    );

    const result = await tool?.execute("tool_fetch_1", {
      url: "https://example.com",
    });

    expect(result?.details).toMatchObject({
      status: "completed",
      result: { url: "https://example.com/", statusCode: 200 },
    });
    expect(calls.map((call) => call.body.status)).toEqual(["running", "completed"]);
  });
});

function recordingTransport(
  handler: (url: string, init: RequestInit, body: Record<string, unknown>) => Response,
): { calls: RecordedCall[]; transport: PiRuntimeTransport } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    transport: async (url, init) => {
      const headers = new Headers(init.headers);
      const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      calls.push({
        url,
        body,
        authorization: headers.get("authorization") ?? undefined,
      });
      return handler(url, init, body);
    },
  };
}

function ok(data: unknown): Response {
  return Response.json({ code: 0, message: "ok", data });
}

function error(status: number, message: string): Response {
  return Response.json({ code: 5000, message, data: null }, { status });
}

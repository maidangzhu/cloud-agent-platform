import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
        return sse([
          {
            event: "chunk",
            data: {
              provider: "fake",
              model: "fake-pi-runtime",
              part: "reason",
              text: "think",
            },
          },
          {
            event: "chunk",
            data: {
              provider: "fake",
              model: "fake-pi-runtime",
              part: "content",
              text: "answer",
            },
          },
          {
            event: "tool_calls",
            data: {
              provider: "fake",
              model: "fake-pi-runtime",
              toolCalls: [
                {
                  id: "tool_1",
                  name: "write_file",
                  arguments: JSON.stringify({ path: "report.md", content: "x" }),
                },
              ],
            },
          },
          {
            event: "done",
            data: {
              provider: "fake",
              model: "fake-pi-runtime",
              finishReason: "tool_calls",
              usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
              durationMs: 10,
              attempts: [],
            },
          },
        ]);
      }
      return error(404, "unexpected path");
    });
    const client = new PiRuntimeControlPlaneClient({ config, transport });
    const streamFn = createLlmProxyStreamFn(client, "fake");

    const stream = await streamFn(model, {
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      tools: [],
    }, { reasoning: "medium" });
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
      stream: true,
      modelHint: "cap-llm-proxy",
      thinkingLevel: "medium",
    });
    expect(calls.filter((call) => call.url.endsWith("/api/ingest/stream-chunk"))).toHaveLength(0);
  });

  it("accepts a content-only stream with no thinking events", async () => {
    const { transport } = recordingTransport((url) => {
      if (url.endsWith("/api/llm-proxy")) {
        return sse([
          { event: "chunk", data: { part: "content", text: "answer" } },
          { event: "done", data: { finishReason: "stop", usage: {} } },
        ]);
      }
      return error(404, "unexpected path");
    });
    const client = new PiRuntimeControlPlaneClient({ config, transport });
    const stream = await createLlmProxyStreamFn(client, "fake")(
      model,
      { systemPrompt: "", messages: [], tools: [] },
      { reasoning: "medium" },
    );
    const events = [];
    for await (const event of stream) events.push(event.type);
    const message = await stream.result();

    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([{ type: "text", text: "answer" }]);
    expect(events).not.toContain("thinking_start");
  });

  it("fails when the LLM proxy stream ends without done", async () => {
    const { transport } = recordingTransport((url) => {
      if (url.endsWith("/api/llm-proxy")) {
        return sse([{ event: "chunk", data: { part: "content", text: "partial" } }]);
      }
      return error(404, "unexpected path");
    });
    const client = new PiRuntimeControlPlaneClient({ config, transport });
    const stream = await createLlmProxyStreamFn(client, "fake")(
      model,
      { systemPrompt: "", messages: [], tools: [] },
      { reasoning: "medium" },
    );
    for await (const _event of stream) {
      // Drain the event stream so the result settles.
    }
    const message = await stream.result();

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe("LLM proxy stream ended before done");
  });

  it("fails when reasoning arrives after content has started", async () => {
    const { transport } = recordingTransport((url) => {
      if (url.endsWith("/api/llm-proxy")) {
        return sse([
          { event: "chunk", data: { part: "content", text: "answer" } },
          { event: "chunk", data: { part: "reason", text: "late thought" } },
          { event: "done", data: { finishReason: "stop", usage: {} } },
        ]);
      }
      return error(404, "unexpected path");
    });
    const client = new PiRuntimeControlPlaneClient({ config, transport });
    const stream = await createLlmProxyStreamFn(client, "fake")(
      model,
      { systemPrompt: "", messages: [], tools: [] },
      { reasoning: "medium" },
    );
    for await (const _event of stream) {
      // Drain the event stream so the result settles.
    }
    const message = await stream.result();

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe("LLM proxy emitted reasoning after content");
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
      eventSeq: 3,
      status: "completed",
    });
  });

  it("writes files through ingest files plus file_written event", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "cap-pi-tools-"));
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
    const client = new PiRuntimeControlPlaneClient({
      config: buildPiRuntimeStartConfig({
        apiBaseUrl: "https://api.sandbox.maidang.me",
        runToken: "run-token",
        workspaceRoot,
        run: {
          id: "run_1",
          workspaceId: "workspace_1",
          threadId: "thread_1",
          userId: "user_1",
          prompt: "Research adapter behavior",
          maxDurationSec: 120,
        },
      }),
      transport,
    });
    const tool = createPiRuntimeAdapterTools(client).find(
      (item) => item.name === "write_file",
    );

    try {
      const result = await tool?.execute("tool_file_1", {
        path: "reports/a.md",
        content: "hello",
        mimeType: "text/markdown",
      });

      expect(result?.details).toMatchObject({ id: "file_1", path: "reports/a.md" });
      expect(result?.terminate).toBeUndefined();
      await expect(readFile(path.join(workspaceRoot, "reports/a.md"), "utf8"))
        .resolves.toBe("hello");
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
        seq: 2,
        type: "file_written",
        payload: { fileId: "file_1", path: "reports/a.md" },
      });
      expect(calls[3].body).toMatchObject({
        eventSeq: 3,
        status: "completed",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("reads files, lists directories, and runs bash in the workspace", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "cap-pi-tools-"));
    const { calls, transport } = recordingTransport((url) => {
      if (url.endsWith("/api/ingest/tool-calls")) return ok({ toolCall: {} });
      return error(404, "unexpected path");
    });
    const client = new PiRuntimeControlPlaneClient({
      config: buildPiRuntimeStartConfig({
        apiBaseUrl: "https://api.sandbox.maidang.me",
        runToken: "run-token",
        workspaceRoot,
        run: {
          id: "run_1",
          workspaceId: "workspace_1",
          threadId: "thread_1",
          userId: "user_1",
          prompt: "Research adapter behavior",
          maxDurationSec: 120,
        },
      }),
      transport,
    });
    const tools = createPiRuntimeAdapterTools(client);

    try {
      await writeFile(path.join(workspaceRoot, "README.md"), "hello", "utf8");
      const read = await tools.find((item) => item.name === "read_file")?.execute(
        "tool_read_1",
        { path: "README.md" },
      );
      const list = await tools
        .find((item) => item.name === "list_directory")
        ?.execute("tool_list_1", { path: "." });
      const run = await tools.find((item) => item.name === "run_command")?.execute(
        "tool_run_1",
        { command: "pwd && cat README.md", timeoutMs: 5000 },
      );

      expect(read?.details).toMatchObject({ path: "README.md", content: "hello" });
      expect(list?.details).toMatchObject({
        entries: [expect.objectContaining({ name: "README.md", kind: "file" })],
      });
      expect(run?.details).toMatchObject({ exitCode: 0, timedOut: false });
      expect(JSON.stringify(run?.details)).toContain("hello");
      expect(calls.map((call) => call.body.status)).toEqual([
        "running",
        "completed",
        "running",
        "completed",
        "running",
        "completed",
      ]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("truncates read_file output over the runtime file-read budget", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "cap-pi-tools-"));
    const { calls, transport } = recordingTransport((url) => {
      if (url.endsWith("/api/ingest/tool-calls")) return ok({ toolCall: {} });
      return error(404, "unexpected path");
    });
    const client = new PiRuntimeControlPlaneClient({
      config: buildPiRuntimeStartConfig({
        apiBaseUrl: "https://api.sandbox.maidang.me",
        runToken: "run-token",
        workspaceRoot,
        run: {
          id: "run_1",
          workspaceId: "workspace_1",
          threadId: "thread_1",
          userId: "user_1",
          prompt: "Research adapter behavior",
          maxDurationSec: 120,
        },
      }),
      transport,
    });
    const tool = createPiRuntimeAdapterTools(client).find(
      (item) => item.name === "read_file",
    );

    try {
      const content = "x".repeat(120_001);
      await writeFile(path.join(workspaceRoot, "large.txt"), content, "utf8");

      const result = await tool?.execute("tool_read_large_1", {
        path: "large.txt",
      });

      expect(result?.details).toMatchObject({
        path: "large.txt",
        size: 120_001,
        truncated: true,
      });
      expect(String(result?.details.content)).toHaveLength(120_000);
      const firstContent = result?.content[0];
      expect(firstContent?.type).toBe("text");
      expect(firstContent?.type === "text" ? firstContent.text : "").toHaveLength(
        120_000,
      );
      expect(calls.map((call) => call.body.status)).toEqual([
        "running",
        "completed",
      ]);
      expect(calls[1].body.result).toMatchObject({
        truncated: true,
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("records run_command non-zero exit as completed terminal output", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "cap-pi-tools-"));
    const { calls, transport } = recordingTransport((url) => {
      if (url.endsWith("/api/ingest/tool-calls")) return ok({ toolCall: {} });
      return error(404, "unexpected path");
    });
    const client = new PiRuntimeControlPlaneClient({
      config: buildPiRuntimeStartConfig({
        apiBaseUrl: "https://api.sandbox.maidang.me",
        runToken: "run-token",
        workspaceRoot,
        run: {
          id: "run_1",
          workspaceId: "workspace_1",
          threadId: "thread_1",
          userId: "user_1",
          prompt: "Research adapter behavior",
          maxDurationSec: 120,
        },
      }),
      transport,
    });
    const tool = createPiRuntimeAdapterTools(client).find(
      (item) => item.name === "run_command",
    );

    try {
      const result = await tool?.execute("tool_run_fail_1", {
        command: "echo nope >&2; exit 7",
        timeoutMs: 5000,
      });

      expect(result?.details).toMatchObject({
        exitCode: 7,
        stderr: "nope\n",
        timedOut: false,
      });
      expect(calls.map((call) => call.body.status)).toEqual([
        "running",
        "completed",
      ]);
      expect(calls[1].body).toMatchObject({
        id: "tool_run_fail_1",
        eventSeq: 3,
        status: "completed",
      });
      expect(JSON.stringify(calls[1].body.result)).toContain('"exitCode":7');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("records run_command timeout as completed terminal output", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "cap-pi-tools-"));
    const { calls, transport } = recordingTransport((url) => {
      if (url.endsWith("/api/ingest/tool-calls")) return ok({ toolCall: {} });
      return error(404, "unexpected path");
    });
    const client = new PiRuntimeControlPlaneClient({
      config: buildPiRuntimeStartConfig({
        apiBaseUrl: "https://api.sandbox.maidang.me",
        runToken: "run-token",
        workspaceRoot,
        run: {
          id: "run_1",
          workspaceId: "workspace_1",
          threadId: "thread_1",
          userId: "user_1",
          prompt: "Research adapter behavior",
          maxDurationSec: 120,
        },
      }),
      transport,
    });
    const tool = createPiRuntimeAdapterTools(client).find(
      (item) => item.name === "run_command",
    );

    try {
      const result = await tool?.execute("tool_run_timeout_1", {
        command: "sleep 5",
        timeoutMs: 1000,
      });

      expect(result?.details).toMatchObject({
        timedOut: true,
      });
      expect(calls.map((call) => call.body.status)).toEqual([
        "running",
        "completed",
      ]);
      expect(JSON.stringify(calls[1].body.result)).toContain('"timedOut":true');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("records run_command policy rejection as failed tool call", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "cap-pi-tools-"));
    const { calls, transport } = recordingTransport((url) => {
      if (url.endsWith("/api/ingest/tool-calls")) return ok({ toolCall: {} });
      return error(404, "unexpected path");
    });
    const client = new PiRuntimeControlPlaneClient({
      config: buildPiRuntimeStartConfig({
        apiBaseUrl: "https://api.sandbox.maidang.me",
        runToken: "run-token",
        workspaceRoot,
        run: {
          id: "run_1",
          workspaceId: "workspace_1",
          threadId: "thread_1",
          userId: "user_1",
          prompt: "Research adapter behavior",
          maxDurationSec: 120,
        },
        toolPolicy: { denyCommands: ["printf blocked"] },
      }),
      transport,
    });
    const tool = createPiRuntimeAdapterTools(client).find(
      (item) => item.name === "run_command",
    );

    try {
      await expect(
        tool?.execute("tool_run_rejected_1", {
          command: "printf blocked",
          timeoutMs: 5000,
        }),
      ).rejects.toThrow(/command rejected by policy/);
      expect(calls.map((call) => call.body.status)).toEqual([
        "running",
        "failed",
      ]);
      expect(calls[1].body).toMatchObject({
        id: "tool_run_rejected_1",
        eventSeq: 3,
        status: "failed",
        error: "command rejected by policy: printf blocked",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
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
    expect(result?.terminate).toBe(true);
    expect(calls[1].url).toBe(`${config.ingestUrl}/artifacts`);
    expect(calls[1].body).toMatchObject({
      eventSeq: 2,
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
      if (url.endsWith("/api/ingest/sources")) {
        return ok({ source: { id: "source_fetch_1" } });
      }
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
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/ingest/tool-calls",
      "/api/ingest/sources",
      "/api/ingest/tool-calls",
    ]);
    expect(calls[1].body).toMatchObject({
      eventSeq: 2,
      kind: "url",
      uri: "https://example.com/",
      title: "Example",
      metadata: {
        statusCode: 200,
        contentType: "text/html",
        truncated: false,
      },
    });
    expect(calls.map((call) => call.body.status).filter(Boolean)).toEqual([
      "running",
      "completed",
    ]);
  });

  it("records fetch_url SSRF rejection as a rejected tool call", async () => {
    const { calls, transport } = recordingTransport((url) => {
      if (url.endsWith("/api/ingest/tool-calls")) return ok({ toolCall: {} });
      return error(404, "unexpected path");
    });
    const client = new PiRuntimeControlPlaneClient({ config, transport });
    const tool = createPiRuntimeAdapterTools(client).find(
      (item) => item.name === "fetch_url",
    );

    await expect(
      tool?.execute("tool_fetch_rejected_1", {
        url: "http://127.0.0.1/private",
      }),
    ).rejects.toThrow("SSRF guard rejected private address");

    expect(calls.map((call) => call.body.status)).toEqual([
      "running",
      "rejected",
    ]);
    expect(calls[1].body).toMatchObject({
      id: "tool_fetch_rejected_1",
      eventSeq: 3,
      status: "rejected",
      error: "SSRF guard rejected private address",
    });
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

function sse(records: Array<{ event: string; data: unknown }>): Response {
  return new Response(
    records.map((record) => [
      `event: ${record.event}`,
      `data: ${JSON.stringify(record.data)}`,
      "",
    ].join("\n")).join("\n"),
    { headers: { "content-type": "text/event-stream" } },
  );
}

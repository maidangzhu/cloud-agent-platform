import { createHash } from "node:crypto";
import { webSearchTool } from "../tools/web-search.js";

export type ScriptedIngestFixtureMode =
  | "complete"
  | "fail"
  | "timeout"
  | "cancel-aware"
  | "file-write"
  | "artifact-create"
  | "source-record"
  | "web-search";

export type ScriptedIngestFixtureRequest = (
  path: string,
  init: RequestInit,
) => Promise<Response>;

export type ScriptedIngestFixtureOptions = {
  request: ScriptedIngestFixtureRequest;
  runToken: string;
  mode: ScriptedIngestFixtureMode;
  artifactId?: string;
  artifactContent?: string;
  sourceKind?: "url" | "file" | "command" | "search_result" | "manual";
  sourceUri?: string;
  sourceTitle?: string;
  searchQuery?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  stepDelayMs?: number;
};

export type ScriptedIngestFixtureResult = {
  mode: ScriptedIngestFixtureMode;
  completed: boolean;
  cancelled: boolean;
  forbiddenEnvPresent: boolean;
  sentCookieHeader: boolean;
  calls: Array<{ path: string; status: number }>;
};

const FORBIDDEN_ENV_KEYS = [
  "DATABASE_URL",
  "DIRECT_URL",
  "BETTER_AUTH_SECRET",
  "RUN_TOKEN_SECRET",
] as const;

const FIXTURE_FILE_CONTENT = "scripted ingest fixture workspace note\n";
const FIXTURE_FILE_PATH = "notes/scripted-ingest-fixture.md";

export async function runScriptedIngestFixture(
  options: ScriptedIngestFixtureOptions,
): Promise<ScriptedIngestFixtureResult> {
  const calls: Array<{ path: string; status: number }> = [];
  const stepDelayMs = options.stepDelayMs ?? 25;
  const toolCallId = `fixture-tool-${options.mode}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  let sentCookieHeader = false;

  const post = async (path: string, body: Record<string, unknown>) => {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.runToken}`,
    };
    sentCookieHeader = sentCookieHeader || "cookie" in headers;
    const response = await options.request(path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    calls.push({ path, status: response.status });
    if (!response.ok) {
      throw new Error(`scripted ingest fixture call failed: ${path} -> ${response.status}`);
    }
    return response;
  };

  await post("/api/ingest/heartbeat", {
    status: "running",
    phase: "boot",
  });
  await post("/api/ingest/events", {
    seq: 1,
    type: "run_created",
    payload: null,
  });
  await delay(stepDelayMs, options.signal);
  await post("/api/ingest/heartbeat", {
    status: "running",
    phase: "agent_loop",
  });
  await post("/api/ingest/events", {
    seq: 2,
    type: "agent_started",
    payload: null,
  });

  if (options.mode === "cancel-aware") {
    await waitForAbort(options.signal);
    await post("/api/ingest/events", {
      seq: 3,
      type: "run_cancelled",
      payload: null,
    });
    return buildResult(options, calls, sentCookieHeader, {
      completed: false,
      cancelled: true,
    });
  }

  if (options.mode === "timeout") {
    return buildResult(options, calls, sentCookieHeader, {
      completed: false,
      cancelled: false,
    });
  }

  if (options.mode === "fail") {
    await post("/api/ingest/events", {
      seq: 3,
      type: "run_failed",
      payload: { errorCode: "SCRIPTED_INGEST_FIXTURE_FAILED" },
    });
    return buildResult(options, calls, sentCookieHeader, {
      completed: false,
      cancelled: false,
    });
  }

  let nextSeq = 3;

  if (options.mode === "file-write") {
    const fileEventSeq = nextSeq++;
    const fileResponse = await post("/api/ingest/files", {
      path: FIXTURE_FILE_PATH,
      kind: "text",
      mimeType: "text/markdown",
      size: byteLength(FIXTURE_FILE_CONTENT),
      contentHash: sha256(FIXTURE_FILE_CONTENT),
      content: FIXTURE_FILE_CONTENT,
      eventSeq: fileEventSeq,
    });
    const file = (await fileResponse.json()).data.file;
    await post("/api/ingest/events", {
      seq: fileEventSeq,
      type: "file_written",
      payload: {
        fileId: file.id,
        path: file.path,
        size: file.size,
        contentHash: file.contentHash,
      },
    });
  }

  if (options.mode === "artifact-create") {
    await post("/api/ingest/artifacts", {
      ...(options.artifactId ? { artifactId: options.artifactId } : {}),
      title: "Scripted Ingest Fixture Report",
      kind: "text",
      contentSnapshot:
        options.artifactContent ?? "scripted ingest fixture artifact content\n",
      eventSeq: nextSeq++,
    });
  }

  if (options.mode === "source-record") {
    await post("/api/ingest/sources", {
      kind: options.sourceKind ?? "url",
      uri: options.sourceUri ?? "https://example.com",
      title: options.sourceTitle ?? "Example",
      ...(options.artifactId ? { artifactId: options.artifactId } : {}),
      eventSeq: nextSeq++,
    });
  }

  if (options.mode === "web-search") {
    const searchToolCallId = `fixture-web-search-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const query = options.searchQuery ?? "redis streams";
    await post("/api/ingest/tool-calls", {
      id: searchToolCallId,
      eventSeq: nextSeq++,
      name: "web_search",
      status: "running",
      args: { query, limit: 2 },
    });
    const searchResult = await webSearchTool({
      query,
      limit: 2,
      runToken: options.runToken,
      request: async (path, init) => {
        const response = await options.request(path, init);
        calls.push({ path, status: response.status });
        return response;
      },
      backoffMs: [0, 0],
      sleep: async () => undefined,
    });
    await post("/api/ingest/tool-calls", {
      id: searchToolCallId,
      eventSeq: nextSeq++,
      name: "web_search",
      status: searchResult.status,
      args: { query, limit: 2 },
      ...(searchResult.status === "completed"
        ? { result: searchResult.result }
        : { error: searchResult.error }),
    });
  }

  const startedSeq = nextSeq++;
  await post("/api/ingest/tool-calls", {
    id: toolCallId,
    eventSeq: startedSeq,
    name: "fake_tool",
    status: "running",
    args: { mode: options.mode },
  });
  const terminalSeq = nextSeq++;
  await post("/api/ingest/tool-calls", {
    id: toolCallId,
    eventSeq: terminalSeq,
    name: "fake_tool",
    status: "completed",
    args: { mode: options.mode },
    result: { ok: true },
  });
  await post("/api/ingest/events", {
    seq: nextSeq++,
    type: "run_completed",
    payload: { durationMs: 1 },
  });

  return buildResult(options, calls, sentCookieHeader, {
    completed: true,
    cancelled: false,
  });
}

function buildResult(
  options: ScriptedIngestFixtureOptions,
  calls: Array<{ path: string; status: number }>,
  sentCookieHeader: boolean,
  result: Pick<ScriptedIngestFixtureResult, "completed" | "cancelled">,
): ScriptedIngestFixtureResult {
  return {
    mode: options.mode,
    ...result,
    forbiddenEnvPresent: FORBIDDEN_ENV_KEYS.some((key) => Boolean(options.env?.[key])),
    sentCookieHeader,
    calls,
  };
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted || !signal) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function sha256(value: string): string {
  const digest = simpleSha256(value);
  return `sha256:${digest}`;
}

function simpleSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

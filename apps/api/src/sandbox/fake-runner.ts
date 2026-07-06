import { createHash } from "node:crypto";

export type FakeRunnerMode =
  | "complete"
  | "fail"
  | "timeout"
  | "cancel-aware"
  | "file-write"
  | "artifact-create"
  | "source-record";

export type FakeRunnerRequest = (
  path: string,
  init: RequestInit,
) => Promise<Response>;

export type FakeRunnerOptions = {
  request: FakeRunnerRequest;
  runToken: string;
  mode: FakeRunnerMode;
  artifactId?: string;
  artifactContent?: string;
  sourceKind?: "url" | "file" | "command" | "search_result" | "manual";
  sourceUri?: string;
  sourceTitle?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  stepDelayMs?: number;
};

export type FakeRunnerResult = {
  mode: FakeRunnerMode;
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

const FAKE_FILE_CONTENT = "fake runner workspace note\n";
const FAKE_FILE_PATH = "notes/fake-runner.md";

export async function runFakeRunner(
  options: FakeRunnerOptions,
): Promise<FakeRunnerResult> {
  const calls: Array<{ path: string; status: number }> = [];
  const stepDelayMs = options.stepDelayMs ?? 25;
  const toolCallId = `fake-tool-${options.mode}-${Date.now()}-${Math.random()
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
      throw new Error(`fake runner call failed: ${path} -> ${response.status}`);
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
      payload: { errorCode: "FAKE_RUNNER_FAILED" },
    });
    return buildResult(options, calls, sentCookieHeader, {
      completed: false,
      cancelled: false,
    });
  }

  if (options.mode === "file-write") {
    const fileResponse = await post("/api/ingest/files", {
      path: FAKE_FILE_PATH,
      kind: "text",
      mimeType: "text/markdown",
      size: byteLength(FAKE_FILE_CONTENT),
      contentHash: sha256(FAKE_FILE_CONTENT),
      content: FAKE_FILE_CONTENT,
      eventSeq: 3,
    });
    const file = (await fileResponse.json()).data.file;
    await post("/api/ingest/events", {
      seq: 3,
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
      title: "Fake Runner Report",
      kind: "text",
      contentSnapshot:
        options.artifactContent ?? "fake runner artifact content\n",
      eventSeq: 3,
    });
  }

  if (options.mode === "source-record") {
    await post("/api/ingest/sources", {
      kind: options.sourceKind ?? "url",
      uri: options.sourceUri ?? "https://example.com",
      title: options.sourceTitle ?? "Example",
      ...(options.artifactId ? { artifactId: options.artifactId } : {}),
      eventSeq: 3,
    });
  }

  const terminalSeq = options.mode === "complete" ? 3 : 4;
  await post("/api/ingest/tool-calls", {
    id: toolCallId,
    eventSeq: terminalSeq,
    name: "fake_tool",
    status: "running",
    args: { mode: options.mode },
  });
  await post("/api/ingest/tool-calls", {
    id: toolCallId,
    eventSeq: terminalSeq,
    name: "fake_tool",
    status: "completed",
    args: { mode: options.mode },
    result: { ok: true },
  });
  await post("/api/ingest/events", {
    seq: terminalSeq + 1,
    type: "run_completed",
    payload: { durationMs: 1 },
  });

  return buildResult(options, calls, sentCookieHeader, {
    completed: true,
    cancelled: false,
  });
}

function buildResult(
  options: FakeRunnerOptions,
  calls: Array<{ path: string; status: number }>,
  sentCookieHeader: boolean,
  result: Pick<FakeRunnerResult, "completed" | "cancelled">,
): FakeRunnerResult {
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

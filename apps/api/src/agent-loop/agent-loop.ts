import { createHash } from "node:crypto";

export type AgentLoopRequest = (
  path: string,
  init: RequestInit,
) => Promise<Response>;

export type AgentLoopConfig = {
  runId: string;
  prompt: string;
  runToken: string;
  request: AgentLoopRequest;
  modelHint?: string;
  stream?: boolean;
  waitForInput?: {
    question: string;
    options?: string[];
  };
  updateArtifactId?: string;
};

export type AgentLoopResult = {
  completed: boolean;
  waitingForInput: boolean;
  cancelled: boolean;
  llmToolCalls: number;
  calls: Array<{ path: string; status: number }>;
};

type LlmToolCall = {
  id: string;
  name: string;
  arguments: string;
};

type LlmOutput = {
  reasoning: string;
  content: string;
  toolCalls: LlmToolCall[];
  model?: string;
};

type SseRecord = {
  event?: string;
  data: string;
};

type JsonRecord = Record<string, unknown>;
type ToolExecutionResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export async function runAgentLoop(
  config: AgentLoopConfig,
): Promise<AgentLoopResult> {
  const calls: AgentLoopResult["calls"] = [];
  const startedAt = Date.now();
  let seq = 1;

  const post = async (path: string, body: JsonRecord): Promise<JsonRecord> => {
    const response = await config.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.runToken}`,
      },
      body: JSON.stringify(body),
    });
    calls.push({ path, status: response.status });
    if (!response.ok) {
      throw new Error(`${path} -> ${response.status} ${await response.text()}`);
    }
    return response.json().catch(() => ({})) as Promise<JsonRecord>;
  };

  const checkCancel = async (): Promise<boolean> => {
    const control = await getRunControl({
      runId: config.runId,
      runToken: config.runToken,
      request: config.request,
    });
    calls.push(...control.calls);
    if (!control.cancelRequested) return false;

    await post("/api/ingest/events", {
      seq: seq++,
      type: "run_cancelled",
      payload: null,
    });
    return true;
  };

  await post("/api/ingest/heartbeat", { status: "running", phase: "boot" });
  if (await checkCancel()) {
    return cancelledResult(calls);
  }
  await post("/api/ingest/events", {
    seq: seq++,
    type: "run_created",
    payload: null,
  });
  await post("/api/ingest/events", {
    seq: seq++,
    type: "runner_started",
    payload: null,
  });
  await post("/api/ingest/heartbeat", {
    status: "running",
    phase: "agent_loop",
  });
  await post("/api/ingest/events", {
    seq: seq++,
    type: "agent_started",
    payload: null,
  });
  if (await checkCancel()) {
    return cancelledResult(calls);
  }

  const llmResponse = await callLlmProxy({
    runId: config.runId,
    prompt: config.prompt,
    runToken: config.runToken,
    request: config.request,
    modelHint: config.modelHint ?? "agent-loop-step16",
    stream: config.stream === true,
  });
  calls.push(...llmResponse.calls);
  if (await checkCancel()) {
    return cancelledResult(calls);
  }

  if (config.stream === true && llmResponse.output.reasoning) {
    await post("/api/ingest/events", {
      seq: seq++,
      type: "agent_thinking",
      title: "Thinking",
      content: llmResponse.output.reasoning,
      payload: {
        ...(llmResponse.output.model ? { model: llmResponse.output.model } : {}),
      },
    });
  }

  const output = llmResponse.output;
  await post("/api/ingest/events", {
    seq: seq++,
    type: "agent_message",
    role: "assistant",
    content: output.content,
    payload: { messageId: `agent-loop-message-${config.runId}` },
  });

  const toolCalls = output.toolCalls;
  for (const toolCall of toolCalls) {
    if (await checkCancel()) {
      return cancelledResult(calls, toolCalls.length);
    }

    const toolCallId = `${config.runId}-${toolCall.id}`;
    const args = parseToolArgs(toolCall.arguments);
    if (toolCall.name === "create_artifact" && config.updateArtifactId) {
      args.artifactId = config.updateArtifactId;
    }
    const startedEventSeq = seq++;
    await post("/api/ingest/tool-calls", {
      id: toolCallId,
      eventSeq: startedEventSeq,
      name: toolCall.name,
      status: "running",
      args,
    });

    const toolEffectEventSeq = seq++;
    const result: ToolExecutionResult =
      toolCall.name === "write_file"
        ? await executeWriteFile(post, args, toolEffectEventSeq)
        : toolCall.name === "create_artifact"
          ? await executeCreateArtifact(post, args, toolEffectEventSeq)
          : { ok: false, error: `unsupported tool: ${toolCall.name}` };

    await post("/api/ingest/tool-calls", {
      id: toolCallId,
      eventSeq: seq++,
      name: toolCall.name,
      status: result.ok ? "completed" : "failed",
      args,
      ...(result.ok ? { result: result.value } : { error: result.error }),
    });

    if (!result.ok) {
      await post("/api/ingest/events", {
        seq: seq++,
        type: "run_failed",
        payload: { errorCode: result.error },
      });
      return {
        completed: false,
        waitingForInput: false,
        cancelled: false,
        llmToolCalls: toolCalls.length,
        calls,
      };
    }

    await post("/api/ingest/heartbeat", {
      status: "running",
      phase: "agent_loop",
    });
    if (await checkCancel()) {
      return cancelledResult(calls, toolCalls.length);
    }
  }

  if (config.waitForInput) {
    await post("/api/ingest/events", {
      seq: seq++,
      type: "run_waiting_for_input",
      payload: config.waitForInput,
    });

    return {
      completed: false,
      waitingForInput: true,
      cancelled: false,
      llmToolCalls: toolCalls.length,
      calls,
    };
  }

  await post("/api/ingest/events", {
    seq: seq++,
    type: "run_completed",
    payload: { durationMs: Date.now() - startedAt },
  });

  return {
    completed: true,
    waitingForInput: false,
    cancelled: false,
    llmToolCalls: toolCalls.length,
    calls,
  };
}

function cancelledResult(
  calls: AgentLoopResult["calls"],
  llmToolCalls = 0,
): AgentLoopResult {
  return {
    completed: false,
    waitingForInput: false,
    cancelled: true,
    llmToolCalls,
    calls,
  };
}

async function callLlmProxy(params: {
  runId: string;
  prompt: string;
  runToken: string;
  request: AgentLoopRequest;
  modelHint: string;
  stream: boolean;
}): Promise<{ output: LlmOutput; calls: AgentLoopResult["calls"] }> {
  const calls: AgentLoopResult["calls"] = [];
  const response = await params.request("/api/llm-proxy", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.runToken}`,
    },
    body: JSON.stringify({
      runId: params.runId,
      provider: "fake",
      modelHint: params.modelHint,
      stream: params.stream,
      messages: [
        {
          role: "system",
          content:
            "You are a deterministic Step 16 agent loop fixture. Use tools to create the report.",
        },
        { role: "user", content: params.prompt },
      ],
      tools: [
        { type: "function", function: { name: "write_file" } },
        { type: "function", function: { name: "create_artifact" } },
      ],
    }),
  });
  calls.push({ path: "/api/llm-proxy", status: response.status });
  if (!response.ok) {
    throw new Error(`/api/llm-proxy -> ${response.status} ${await response.text()}`);
  }

  if (params.stream) {
    return {
      calls,
      output: await consumeLlmStream(response),
    };
  }

  const llm = (await response.json().catch(() => ({}))) as JsonRecord;
  const data = asRecord(llm.data);
  const output = asRecord(data.output);
  return {
    calls,
    output: {
      reasoning: stringField(output.reasoning) ?? "",
      content: stringField(output.content) ?? "",
      toolCalls: normalizeToolCalls(output.toolCalls),
      model: stringField(data.model),
    },
  };
}

async function consumeLlmStream(response: Response): Promise<LlmOutput> {
  const records = await readSseRecords(response);
  let reasoning = "";
  let content = "";
  let model: string | undefined;
  let toolCalls: LlmToolCall[] = [];

  for (const record of records) {
    const data = asRecord(JSON.parse(record.data) as unknown);
    if (record.event === "chunk") {
      const part = stringField(data.part);
      const text = stringField(data.text) ?? "";
      model = stringField(data.model) ?? model;
      if (part === "reason") {
        reasoning += text;
      }
      if (part === "content") {
        content += text;
      }
      continue;
    }
    if (record.event === "tool_calls") {
      model = stringField(data.model) ?? model;
      toolCalls = normalizeToolCalls(data.toolCalls);
    }
  }

  return { reasoning, content, toolCalls, model };
}

async function getRunControl(params: {
  runId: string;
  runToken: string;
  request: AgentLoopRequest;
}): Promise<{
  cancelRequested: boolean;
  status?: string;
  calls: AgentLoopResult["calls"];
}> {
  const response = await params.request(`/api/runs/${params.runId}/control`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${params.runToken}`,
    },
  });
  const calls = [{ path: `/api/runs/${params.runId}/control`, status: response.status }];
  if (!response.ok) {
    throw new Error(
      `/api/runs/${params.runId}/control -> ${response.status} ${await response.text()}`,
    );
  }
  const body = (await response.json().catch(() => ({}))) as JsonRecord;
  const data = asRecord(body.data);
  return {
    cancelRequested: data.cancelRequested === true,
    status: stringField(data.status),
    calls,
  };
}

async function readSseRecords(response: Response): Promise<SseRecord[]> {
  const text = await response.text();
  return text
    .trim()
    .split(/\n\n+/)
    .filter(Boolean)
    .map((chunk) => {
      const record: SseRecord = { data: "" };
      for (const line of chunk.split(/\n/)) {
        if (line.startsWith("event: ")) record.event = line.slice(7);
        if (line.startsWith("data: ")) {
          record.data = record.data
            ? `${record.data}\n${line.slice(6)}`
            : line.slice(6);
        }
      }
      return record;
    });
}

async function executeWriteFile(
  post: (path: string, body: JsonRecord) => Promise<JsonRecord>,
  args: JsonRecord,
  eventSeq: number,
): Promise<ToolExecutionResult> {
  const filePath = stringField(args.path);
  const content = stringField(args.content);
  if (!filePath || content === undefined) {
    return { ok: false, error: "write_file requires path and content" };
  }

  const fileResponse = await post("/api/ingest/files", {
    path: filePath,
    kind: "text",
    mimeType: stringField(args.mimeType) ?? "text/markdown",
    size: new TextEncoder().encode(content).byteLength,
    contentHash: sha256(content),
    content,
  });
  const file = asRecord(asRecord(fileResponse.data).file);
  await post("/api/ingest/events", {
    seq: eventSeq,
    type: "file_written",
    payload: {
      fileId: stringField(file.id) ?? filePath,
      path: stringField(file.path) ?? filePath,
      size: numberField(file.size),
      contentHash: stringField(file.contentHash) ?? sha256(content),
    },
  });
  return { ok: true, value: { fileId: file.id, path: file.path } };
}

async function executeCreateArtifact(
  post: (path: string, body: JsonRecord) => Promise<JsonRecord>,
  args: JsonRecord,
  eventSeq: number,
): Promise<ToolExecutionResult> {
  const title = stringField(args.title);
  const kind = stringField(args.kind);
  if (!title || !kind) {
    return { ok: false, error: "create_artifact requires title and kind" };
  }
  const artifactResponse = await post("/api/ingest/artifacts", {
    ...(stringField(args.artifactId)
      ? { artifactId: stringField(args.artifactId) }
      : {}),
    title,
    kind,
    ...(stringField(args.path) ? { path: stringField(args.path) } : {}),
    ...(stringField(args.contentSnapshot)
      ? { contentSnapshot: stringField(args.contentSnapshot) }
      : {}),
    eventSeq,
  });
  const artifact = asRecord(asRecord(artifactResponse.data).artifact);
  return {
    ok: true,
    value: {
      artifactId: artifact.id,
      title: artifact.title,
      version: artifact.version,
    },
  };
}

function normalizeToolCalls(value: unknown): LlmToolCall[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const id = stringField(record.id);
      const name = stringField(record.name);
      const args = stringField(record.arguments);
      if (!id || !name || args === undefined) return null;
      return { id, name, arguments: args };
    })
    .filter((item): item is LlmToolCall => Boolean(item));
}

function parseToolArgs(value: string): JsonRecord {
  const parsed = JSON.parse(value) as unknown;
  return asRecord(parsed);
}

function asRecord(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as JsonRecord;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

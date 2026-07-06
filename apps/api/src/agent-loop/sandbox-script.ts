export const AGENT_LOOP_SANDBOX_SCRIPT = `
import { createHash } from "node:crypto";
import fs from "node:fs/promises";

const forbidden = ["DATABASE_URL", "DIRECT_URL", "BETTER_AUTH_SECRET", "RUN_TOKEN_SECRET", "OPENAI_API_KEY", "EXA_API_KEY"];
const forbiddenEnvPresent = forbidden.some((key) => Boolean(process.env[key]));
const manifest = JSON.parse(await fs.readFile("agent-loop-manifest.json", "utf8"));

let seq = 1;
const startedAt = Date.now();
const calls = [];

async function post(path, body) {
  const response = await fetch(manifest.apiBaseUrl + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + manifest.runToken
    },
    body: JSON.stringify(body)
  });
  calls.push({ path, status: response.status });
  if (!response.ok) {
    throw new Error(path + " -> " + response.status + " " + await response.text());
  }
  return response.json().catch(() => ({}));
}

async function getControl() {
  const path = "/api/runs/" + manifest.runId + "/control";
  const response = await fetch(manifest.apiBaseUrl + path, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + manifest.runToken
    }
  });
  calls.push({ path, status: response.status });
  if (!response.ok) {
    throw new Error(path + " -> " + response.status + " " + await response.text());
  }
  return response.json().catch(() => ({}));
}

async function stopIfCancelled(llmToolCalls = 0) {
  const control = await getControl();
  if (!control?.data?.cancelRequested) return false;
  await post("/api/ingest/events", {
    seq: seq++,
    type: "run_cancelled",
    payload: null
  });
  console.log(JSON.stringify({
    insideSandbox: true,
    forbiddenEnvPresent,
    waitingForInput: false,
    cancelled: true,
    llmToolCalls,
    calls
  }));
  return true;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sha256(value) {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function parseToolArgs(value) {
  return asRecord(JSON.parse(value));
}

async function executeWriteFile(args, eventSeq) {
  const content = String(args.content ?? "");
  const fileResponse = await post("/api/ingest/files", {
    path: args.path,
    kind: "text",
    mimeType: args.mimeType ?? "text/markdown",
    size: byteLength(content),
    contentHash: sha256(content),
    content
  });
  const file = asRecord(asRecord(fileResponse.data).file);
  await post("/api/ingest/events", {
    seq: eventSeq,
    type: "file_written",
    payload: {
      fileId: file.id,
      path: file.path,
      size: file.size,
      contentHash: file.contentHash
    }
  });
  return { fileId: file.id, path: file.path };
}

async function executeCreateArtifact(args, eventSeq) {
  const artifactResponse = await post("/api/ingest/artifacts", {
    ...(args.artifactId ? { artifactId: args.artifactId } : {}),
    title: args.title,
    kind: args.kind,
    ...(args.path ? { path: args.path } : {}),
    ...(args.contentSnapshot ? { contentSnapshot: args.contentSnapshot } : {}),
    eventSeq
  });
  const artifact = asRecord(asRecord(artifactResponse.data).artifact);
  return { artifactId: artifact.id, title: artifact.title, version: artifact.version };
}

await post("/api/ingest/heartbeat", { status: "running", phase: "boot" });
if (await stopIfCancelled()) process.exit(0);
await post("/api/ingest/events", { seq: seq++, type: "run_created", payload: null });
await post("/api/ingest/events", { seq: seq++, type: "runner_started", payload: null });
await post("/api/ingest/heartbeat", { status: "running", phase: "agent_loop" });
await post("/api/ingest/events", { seq: seq++, type: "agent_started", payload: null });
if (await stopIfCancelled()) process.exit(0);

const llm = await post("/api/llm-proxy", {
  runId: manifest.runId,
  provider: "fake",
  modelHint: "agent-loop-step16",
  stream: false,
  messages: [
    {
      role: "system",
      content: "You are a deterministic Step 16 agent loop fixture. Use tools to create the report."
    },
    { role: "user", content: manifest.prompt }
  ],
  tools: [
    { type: "function", function: { name: "write_file" } },
    { type: "function", function: { name: "create_artifact" } }
  ]
});
if (await stopIfCancelled()) process.exit(0);

const output = asRecord(asRecord(llm.data).output);
await post("/api/ingest/events", {
  seq: seq++,
  type: "agent_message",
  role: "assistant",
  content: output.content ?? "",
  payload: { messageId: "agent-loop-message-" + manifest.runId }
});

const toolCalls = Array.isArray(output.toolCalls) ? output.toolCalls : [];
for (const call of toolCalls) {
  if (await stopIfCancelled(toolCalls.length)) process.exit(0);
  const toolCallId = manifest.runId + "-" + call.id;
  const args = parseToolArgs(call.arguments ?? "{}");
  if (call.name === "create_artifact" && manifest.updateArtifactId) {
    args.artifactId = manifest.updateArtifactId;
  }
  await post("/api/ingest/tool-calls", {
    id: toolCallId,
    eventSeq: seq,
    name: call.name,
    status: "running",
    args
  });

  let result;
  if (call.name === "write_file") {
    result = await executeWriteFile(args, seq++);
  } else if (call.name === "create_artifact") {
    result = await executeCreateArtifact(args, seq++);
  } else {
    throw new Error("unsupported tool: " + call.name);
  }

  await post("/api/ingest/tool-calls", {
    id: toolCallId,
    eventSeq: seq - 1,
    name: call.name,
    status: "completed",
    args,
    result
  });
  await post("/api/ingest/heartbeat", { status: "running", phase: "agent_loop" });
  if (await stopIfCancelled(toolCalls.length)) process.exit(0);
}

if (manifest.waitForInput) {
  await post("/api/ingest/events", {
    seq: seq++,
    type: "run_waiting_for_input",
    payload: manifest.waitForInput
  });
} else {
  await post("/api/ingest/events", {
    seq: seq++,
    type: "run_completed",
    payload: { durationMs: Date.now() - startedAt }
  });
}

console.log(JSON.stringify({
  insideSandbox: true,
  forbiddenEnvPresent,
  waitingForInput: Boolean(manifest.waitForInput),
  cancelled: false,
  llmToolCalls: toolCalls.length,
  calls
}));
`.trim();

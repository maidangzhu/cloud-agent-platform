import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { prisma } from "@cap/db";
import { extractBearerRunToken, verifyRunToken } from "../run/run-token.js";
import { isTerminalStatus, type RunStatus } from "../run/transitions.js";
import {
  completeWithRealProvider,
  fakeComplete,
  streamWithRealProvider,
  type LlmMessage,
  type LlmProviderResult,
  type LlmStreamDelta,
} from "./provider.js";
import { recordLLMUsage } from "../usage/store.js";
import { addRunStreamChunk } from "../redis/streams.js";

type AuthenticatedRun = {
  id: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  status: RunStatus;
  maxDurationSec: number;
};

type LlmSseWriter = {
  writeSSE(input: {
    event?: string;
    data: string;
    id?: string;
  }): Promise<void>;
};

export const llmRoutes = new Hono();

llmRoutes.post("/api/llm-proxy", async (c) => {
  const body = await readJsonObject(c.req.raw);
  if (!body) {
    return c.json({ code: 1001, message: "bad request", data: null }, 400);
  }

  const run = await authenticateRunToken(c.req.header("authorization"), body);
  if (run instanceof Response) return run;

  if (isTerminalStatus(run.status)) {
    return c.json({ code: 2003, message: "run is terminal", data: null }, 409);
  }
  if (run.status === "waiting_for_input") {
    return c.json(
      { code: 2005, message: "run is not accepting llm calls", data: null },
      409,
    );
  }

  const parsed = parseLlmProxyBody(body);
  if (parsed.ok === false) {
    return c.json({ code: 1006, message: parsed.message, data: null }, 400);
  }

  if (parsed.stream) {
    return streamSSE(c, async (stream) => {
      const onDelta = (delta: LlmStreamDelta) =>
        fanOutLlmDelta(stream, run, delta);
      const result =
        parsed.provider === "real"
          ? await streamWithRealProvider({
              messages: parsed.messages,
              tools: parsed.tools,
              modelHint: parsed.modelHint,
              reasoningEffort: parsed.thinkingLevel,
              onDelta,
            })
          : await streamFakeProvider({
              messages: parsed.messages,
              modelHint: parsed.modelHint,
              onDelta,
            });
      if (result.ok === false) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ code: result.code, message: result.message }),
        });
        return;
      }
      await recordUsageBestEffort(run.id, result.result);
      await writeLlmTerminal(stream, result.result);
    });
  }

  const result =
    parsed.provider === "real"
      ? await completeWithRealProvider({
          messages: parsed.messages,
          tools: parsed.tools,
          modelHint: parsed.modelHint,
          reasoningEffort: parsed.thinkingLevel,
        })
      : { ok: true as const, result: fakeComplete(parsed.messages, parsed.modelHint) };
  if (result.ok === false) {
    return jsonResponse(result.code, result.message, result.status);
  }
  await recordUsageBestEffort(run.id, result.result);

  return c.json({
    code: 0,
    message: "ok",
    data: {
      provider: result.result.provider,
      model: result.result.model,
      output: {
        role: "assistant",
        reasoning: result.result.reasoning,
        content: result.result.content,
        toolCalls: result.result.toolCalls,
      },
      finishReason: result.result.finishReason,
      usage: result.result.usage,
      durationMs: result.result.durationMs,
      attempts: result.result.attempts,
    },
  });
});

function parseLlmProxyBody(
  body: Record<string, unknown>,
):
  | {
      ok: true;
      messages: LlmMessage[];
      modelHint: string;
      provider: "fake" | "real";
      stream: boolean;
      tools: unknown[];
      thinkingLevel: string;
    }
  | { ok: false; message: string } {
  if (!Array.isArray(body.messages)) {
    return { ok: false, message: "messages must be an array" };
  }

  const messages: LlmMessage[] = [];
  for (const message of body.messages) {
    if (
      typeof message !== "object" ||
      message === null ||
      Array.isArray(message)
    ) {
      return { ok: false, message: "messages must contain objects" };
    }
    const record = message as Record<string, unknown>;
    if (
      record.role !== "system" &&
      record.role !== "user" &&
      record.role !== "assistant" &&
      record.role !== "tool"
    ) {
      return { ok: false, message: "message role is invalid" };
    }
    if (typeof record.content !== "string") {
      return { ok: false, message: "message content must be a string" };
    }
    messages.push({ role: record.role, content: record.content });
  }

  return {
    ok: true,
    messages,
    modelHint:
      typeof body.modelHint === "string" && body.modelHint.length > 0
        ? body.modelHint
        : "research-default",
    provider: body.provider === "real" ? "real" : "fake",
    stream: body.stream === true,
    tools: Array.isArray(body.tools) ? body.tools : [],
    thinkingLevel:
      typeof body.thinkingLevel === "string" &&
      ["minimal", "low", "medium", "high", "xhigh"].includes(body.thinkingLevel)
        ? body.thinkingLevel
        : "off",
  };
}

async function recordUsageBestEffort(
  runId: string,
  result: LlmProviderResult,
): Promise<void> {
  try {
    await recordLLMUsage({
      runId,
      provider: result.provider,
      model: result.model,
      promptTokens: result.usage.inputTokens,
      completionTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
      durationMs: result.durationMs,
    });
  } catch (err) {
    console.warn("[llm-proxy] failed to record usage", {
      runId,
      provider: result.provider,
      model: result.model,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function streamFakeProvider(input: {
  messages: LlmMessage[];
  modelHint: string;
  onDelta: (delta: LlmStreamDelta) => Promise<void>;
}): Promise<{ ok: true; result: LlmProviderResult }> {
  const result = fakeComplete(input.messages, input.modelHint);
  if (result.reasoning) {
    await input.onDelta({
      provider: result.provider,
      model: result.model,
      part: "reason",
      text: result.reasoning,
    });
  }
  if (result.content) {
    await input.onDelta({
      provider: result.provider,
      model: result.model,
      part: "content",
      text: result.content,
    });
  }
  return { ok: true, result };
}

async function fanOutLlmDelta(
  stream: LlmSseWriter,
  run: AuthenticatedRun,
  delta: LlmStreamDelta,
): Promise<void> {
  await Promise.all([
    stream.writeSSE({
      event: "chunk",
      data: JSON.stringify({
        provider: delta.provider,
        model: delta.model,
        part: delta.part,
        text: delta.text,
      }),
    }),
    addRunStreamChunk({
      runId: run.id,
      streamType: delta.part === "reason" ? "thinking" : "content",
      chunk: delta.text,
      ttlSeconds: run.maxDurationSec + 300,
    }),
  ]);
}

async function writeLlmTerminal(
  stream: LlmSseWriter,
  result: LlmProviderResult,
): Promise<void> {
  if (result.toolCalls.length > 0) {
    await stream.writeSSE({
      event: "tool_calls",
      data: JSON.stringify({
        provider: result.provider,
        model: result.model,
        toolCalls: result.toolCalls,
      }),
    });
  }
  await stream.writeSSE({
    event: "done",
    data: JSON.stringify({
      provider: result.provider,
      model: result.model,
      finishReason: result.finishReason,
      usage: result.usage,
      durationMs: result.durationMs,
      attempts: result.attempts,
    }),
  });
}

async function authenticateRunToken(
  authorizationHeader: string | undefined,
  body: Record<string, unknown>,
): Promise<AuthenticatedRun | Response> {
  const token = extractBearerRunToken(authorizationHeader);
  if (!token) {
    return jsonResponse(1002, "unauthorized", 401);
  }

  const bodyRunId = typeof body.runId === "string" ? body.runId : undefined;
  const verified = verifyRunToken(token, {
    expected: bodyRunId ? { runId: bodyRunId } : undefined,
  });
  if (verified.ok === false) {
    return jsonResponse(2002, "run token invalid", 401);
  }

  const run = await prisma.agentRun.findUnique({
    where: { id: verified.claims.runId },
  });
  if (
    !run ||
    run.userId !== verified.claims.userId ||
    run.workspaceId !== verified.claims.workspaceId ||
    run.threadId !== verified.claims.threadId
  ) {
    return jsonResponse(2002, "run token invalid", 401);
  }

  return {
    id: run.id,
    workspaceId: run.workspaceId,
    threadId: run.threadId,
    userId: run.userId,
    status: run.status as RunStatus,
    maxDurationSec: run.maxDurationSec,
  };
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const parsed = await request.json().catch((): unknown => null);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

function jsonResponse(code: number, message: string, status: number): Response {
  return new Response(JSON.stringify({ code, message, data: null }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

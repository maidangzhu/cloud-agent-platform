import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult, StreamFn } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { fetchUrlTool, type FetchUrlResult } from "../tools/fetch-url.js";
import type { PiRuntimeStartConfig } from "./config.js";
import {
  asRecord,
  PiRuntimeControlPlaneClient,
  stringField,
  type ControlPlaneJson,
  type PiRuntimeTransport,
} from "./control-plane-client.js";

export type PiRuntimeAdaptersOptions = {
  config: PiRuntimeStartConfig;
  client?: PiRuntimeControlPlaneClient;
  transport?: PiRuntimeTransport;
  llmProvider?: "fake" | "real";
  searchProvider?: "fake" | "http" | "exa";
};

export type PiRuntimeAdapters = {
  client: PiRuntimeControlPlaneClient;
  streamFn: StreamFn;
  tools: AgentTool[];
};

export function createPiRuntimeAdapters(
  options: PiRuntimeAdaptersOptions,
): PiRuntimeAdapters {
  const client =
    options.client ??
    new PiRuntimeControlPlaneClient({
      config: options.config,
      transport: options.transport,
    });

  return {
    client,
    streamFn: createLlmProxyStreamFn(client, options.llmProvider),
    tools: createPiRuntimeAdapterTools(client, options.searchProvider),
  };
}

export function createLlmProxyStreamFn(
  client: PiRuntimeControlPlaneClient,
  provider: "fake" | "real" = "real",
): StreamFn {
  return async (model, context) => {
    const stream = createAssistantMessageEventStream();
    void resolveLlmProxyStream(stream, client, model, context, provider);
    return stream;
  };
}

export function createPiRuntimeAdapterTools(
  client: PiRuntimeControlPlaneClient,
  searchProvider?: "fake" | "http" | "exa",
): AgentTool[] {
  return [
    {
      name: "web_search",
      label: "Web search",
      description: "Search the web through the hosted Control Plane search proxy.",
      parameters: Type.Object({
        query: Type.String(),
        limit: Type.Optional(Type.Number()),
      }),
      execute: async (toolCallId, rawParams) => {
        const params = rawParams as { query: string; limit?: number };
        return runTrackedTool(client, {
          toolCallId,
          name: "web_search",
          args: params,
          run: async () => {
            const data = await client.callSearchProxy({
              query: params.query,
              limit: params.limit,
              provider: searchProvider,
            });
            return toolResult([JSON.stringify(data.results ?? [])], data);
          },
        });
      },
    },
    {
      name: "fetch_url",
      label: "Fetch URL",
      description: "Fetch and clean a public URL through the runtime fetch adapter.",
      parameters: Type.Object({
        url: Type.String(),
      }),
      execute: async (toolCallId, rawParams, signal) => {
        const params = rawParams as { url: string };
        return runTrackedTool(client, {
          toolCallId,
          name: "fetch_url",
          args: params,
          run: async () => {
            const result = await fetchUrlTool({
              url: params.url,
              transport: (url, init) => fetch(url, { ...init, signal }),
            });
            if (result.status !== "completed") {
              throw new Error(fetchUrlError(result));
            }
            return toolResult(
              [result.result.text ?? `Fetched ${result.result.url}`],
              result,
            );
          },
        });
      },
    },
    {
      name: "write_file",
      label: "Write file",
      description: "Write a workspace file through hosted ingest APIs.",
      parameters: Type.Object({
        path: Type.String(),
        content: Type.String(),
        mimeType: Type.Optional(Type.String()),
      }),
      execute: async (toolCallId, rawParams) => {
        const params = rawParams as {
          path: string;
          content: string;
          mimeType?: string;
        };
        return runTrackedTool(client, {
          toolCallId,
          name: "write_file",
          args: params,
          run: async (eventSeq) => {
            const result = await client.writeTextFile({
              path: params.path,
              content: params.content,
              mimeType: params.mimeType,
              eventSeq,
            });
            return toolResult(
              [`Wrote ${stringField(result.file.path) ?? params.path}`],
              result.file,
            );
          },
        });
      },
    },
    {
      name: "create_artifact",
      label: "Create artifact",
      description:
        "Create or update a workspace artifact through hosted ingest APIs. Use kind text, code, sheet, or image.",
      parameters: Type.Object({
        title: Type.String(),
        kind: Type.Enum(["text", "code", "sheet", "image"]),
        path: Type.Optional(Type.String()),
        contentSnapshot: Type.Optional(Type.String()),
        storageKey: Type.Optional(Type.String()),
        artifactId: Type.Optional(Type.String()),
      }),
      execute: async (toolCallId, rawParams) => {
        const params = rawParams as {
          title: string;
          kind: string;
          path?: string;
          contentSnapshot?: string;
          storageKey?: string;
          artifactId?: string;
        };
        return runTrackedTool(client, {
          toolCallId,
          name: "create_artifact",
          args: params,
          run: async (eventSeq) => {
            const result = await client.createOrUpdateArtifact({
              title: params.title,
              kind: params.kind,
              path: params.path,
              contentSnapshot: params.contentSnapshot,
              storageKey: params.storageKey,
              artifactId: params.artifactId,
              eventSeq,
            });
            return toolResult(
              [`Created artifact ${stringField(result.artifact.title) ?? params.title}`],
              result.artifact,
              true,
            );
          },
        });
      },
    },
  ];
}

async function resolveLlmProxyStream(
  stream: AssistantMessageEventStream,
  client: PiRuntimeControlPlaneClient,
  model: Model<any>,
  context: Context,
  provider: "fake" | "real",
): Promise<void> {
  const startedAt = Date.now();
  try {
    const data = await client.callLlmProxy({
      provider,
      modelHint: model.id,
      stream: false,
      messages: toLlmProxyMessages(context),
      tools: context.tools ?? [],
    });
    const output = asRecord(data.output);
    const reasoning = stringField(output.reasoning);
    const content = stringField(output.content) ?? "";
    const message = createAssistantMessage({
      model,
      data,
      content,
      reasoning,
      toolCalls: normalizeToolCalls(output.toolCalls),
      stopReason:
        stringField(data.finishReason) === "tool_calls" ? "toolUse" : "stop",
      startedAt,
    });

    await Promise.all([
      reasoning ? client.postStreamChunk("thinking", reasoning) : Promise.resolve(null),
      content ? client.postStreamChunk("content", content) : Promise.resolve(null),
    ]);

    stream.push({ type: "start", partial: message });
    if (reasoning) {
      stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
      stream.push({
        type: "thinking_delta",
        contentIndex: 0,
        delta: reasoning,
        partial: message,
      });
      stream.push({
        type: "thinking_end",
        contentIndex: 0,
        content: reasoning,
        partial: message,
      });
    }
    if (content) {
      const contentIndex = reasoning ? 1 : 0;
      stream.push({ type: "text_start", contentIndex, partial: message });
      stream.push({
        type: "text_delta",
        contentIndex,
        delta: content,
        partial: message,
      });
      stream.push({
        type: "text_end",
        contentIndex,
        content,
        partial: message,
      });
    }
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
    stream.end(message);
  } catch (err) {
    const message = createAssistantMessage({
      model,
      data: {},
      content: "",
      toolCalls: [],
      stopReason: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
      startedAt,
    });
    stream.push({ type: "error", reason: "error", error: message });
    stream.end(message);
  }
}

async function runTrackedTool<TDetails>(
  client: PiRuntimeControlPlaneClient,
  input: {
    toolCallId: string;
    name: string;
    args: unknown;
    run: (eventSeq: number) => Promise<AgentToolResult<TDetails>>;
  },
): Promise<AgentToolResult<TDetails>> {
  const eventSeq = client.nextSeq();
  await client.postToolCall({
    id: input.toolCallId,
    eventSeq,
    name: input.name,
    status: "running",
    args: input.args,
  });
  try {
    const result = await input.run(eventSeq);
    await client.postToolCall({
      id: input.toolCallId,
      eventSeq,
      name: input.name,
      status: "completed",
      args: input.args,
      result: result.details,
      completedAt: new Date(),
    });
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await client.postToolCall({
      id: input.toolCallId,
      eventSeq,
      name: input.name,
      status: "failed",
      args: input.args,
      error,
      completedAt: new Date(),
    });
    throw err;
  }
}

function createAssistantMessage(input: {
  model: Model<any>;
  data: ControlPlaneJson;
  content: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  stopReason: AssistantMessage["stopReason"];
  errorMessage?: string;
  startedAt: number;
}): AssistantMessage {
  const content = [
    ...(input.reasoning ? [{ type: "thinking" as const, thinking: input.reasoning }] : []),
    ...(input.content ? [{ type: "text" as const, text: input.content }] : []),
    ...input.toolCalls,
  ];
  return {
    role: "assistant",
    content,
    api: input.model.api,
    provider: input.model.provider,
    model: input.model.id,
    responseModel: stringField(input.data.model),
    usage: normalizeUsage(input.data.usage),
    stopReason: input.stopReason,
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    timestamp: input.startedAt,
  };
}

function normalizeUsage(value: unknown): AssistantMessage["usage"] {
  const usage = asRecord(value);
  const input = numberValue(usage.inputTokens);
  const output = numberValue(usage.outputTokens);
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: numberValue(usage.totalTokens) || input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function toLlmProxyMessages(context: Context) {
  const messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }> = [];
  if (context.systemPrompt) {
    messages.push({ role: "system", content: context.systemPrompt });
  }
  for (const message of context.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: stringifyMessageContent(message.content) });
    }
    if (message.role === "assistant") {
      messages.push({ role: "assistant", content: stringifyMessageContent(message.content) });
    }
    if (message.role === "toolResult") {
      messages.push({ role: "tool", content: stringifyMessageContent(message.content) });
    }
  }
  return messages;
}

function stringifyMessageContent(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "thinking") return part.thinking;
      if (part.type === "toolCall") return JSON.stringify(part.arguments);
      return `[${part.mimeType} image]`;
    })
    .join("\n");
}

function normalizeToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      const id = stringField(record.id);
      const name = stringField(record.name);
      if (!id || !name) return null;
      return {
        type: "toolCall" as const,
        id,
        name,
        arguments:
          typeof record.arguments === "string"
            ? parseJsonRecord(record.arguments)
            : asRecord(record.arguments),
      };
    })
    .filter((item): item is ToolCall => Boolean(item));
}

function toolResult<TDetails>(
  text: string[],
  details: TDetails,
  terminate = false,
): AgentToolResult<TDetails> {
  return {
    content: text.map((content) => ({ type: "text" as const, text: content })),
    details,
    ...(terminate ? { terminate: true } : {}),
  };
}

function fetchUrlError(result: Exclude<FetchUrlResult, { status: "completed" }>): string {
  return result.error;
}

function parseJsonRecord(value: string): Record<string, unknown> {
  return asRecord(JSON.parse(value) as unknown);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

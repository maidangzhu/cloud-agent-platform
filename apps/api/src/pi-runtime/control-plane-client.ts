import { createHash } from "node:crypto";
import type { RunToolCallStatus } from "@cap/db";
import type { RunEventInput, RunEventType } from "../run/event-store.js";
import type { StreamChunkType } from "../redis/streams.js";
import type { PiRuntimeStartConfig } from "./config.js";

export type PiRuntimeTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export type ControlPlaneJson = Record<string, unknown>;

export class PiRuntimeControlPlaneError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = "PiRuntimeControlPlaneError";
  }
}

export type PiRuntimeControlPlaneClientOptions = {
  config: PiRuntimeStartConfig;
  transport?: PiRuntimeTransport;
};

export class PiRuntimeControlPlaneClient {
  readonly config: PiRuntimeStartConfig;
  private readonly transport: PiRuntimeTransport;
  private seq = 1;

  constructor(options: PiRuntimeControlPlaneClientOptions) {
    this.config = options.config;
    this.transport = options.transport ?? fetch;
  }

  nextSeq(): number {
    const current = this.seq;
    this.seq += 1;
    return current;
  }

  async postRunEvent<T extends RunEventType>(
    input: Omit<RunEventInput<T>, "runId" | "seq"> & { seq?: number },
  ): Promise<{ seq: number; data: ControlPlaneJson }> {
    const seq = input.seq ?? this.nextSeq();
    const { data } = await this.postJson(`${this.config.ingestUrl}/events`, {
      runId: this.config.runId,
      seq,
      type: input.type,
      ...(input.role ? { role: input.role } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.content ? { content: input.content } : {}),
      payload: input.payload,
    });
    return { seq, data };
  }

  async postHeartbeat(phase: string): Promise<ControlPlaneJson> {
    const { data } = await this.postJson(`${this.config.ingestUrl}/heartbeat`, {
      runId: this.config.runId,
      status: "running",
      phase,
    });
    return data;
  }

  async postStreamChunk(
    streamType: StreamChunkType,
    chunk: string,
  ): Promise<ControlPlaneJson | null> {
    if (!chunk) return null;
    const { data } = await this.postJson(`${this.config.ingestUrl}/stream-chunk`, {
      runId: this.config.runId,
      streamType,
      chunk,
    });
    return data;
  }

  async postToolCall(input: {
    id: string;
    eventSeq: number;
    name: string;
    status: RunToolCallStatus;
    args: unknown;
    result?: unknown;
    error?: string;
    completedAt?: Date;
  }): Promise<ControlPlaneJson> {
    const { data } = await this.postJson(`${this.config.ingestUrl}/tool-calls`, {
      runId: this.config.runId,
      id: input.id,
      eventSeq: input.eventSeq,
      name: input.name,
      status: input.status,
      args: input.args,
      ...(input.result !== undefined ? { result: input.result } : {}),
      ...(input.error ? { error: input.error } : {}),
      ...(input.completedAt
        ? { completedAt: input.completedAt.toISOString() }
        : {}),
    });
    return data;
  }

  async callLlmProxy(input: {
    messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
    tools?: unknown[];
    modelHint?: string;
    provider?: "fake" | "real";
    stream?: boolean;
  }): Promise<ControlPlaneJson> {
    const { data } = await this.postJson(this.config.llmProxyUrl, {
      runId: this.config.runId,
      provider: input.provider ?? "real",
      modelHint: input.modelHint ?? "pi-runtime",
      stream: input.stream === true,
      messages: input.messages,
      tools: input.tools ?? [],
    });
    return data;
  }

  async callSearchProxy(input: {
    query: string;
    limit?: number;
    provider?: "fake" | "http" | "exa";
  }): Promise<ControlPlaneJson> {
    const { data } = await this.postJson(this.config.searchProxyUrl, {
      runId: this.config.runId,
      query: input.query,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
    });
    return data;
  }

  async writeTextFile(input: {
    path: string;
    content: string;
    mimeType?: string;
    eventSeq?: number;
  }): Promise<{ file: ControlPlaneJson; eventSeq: number }> {
    const contentHash = sha256(input.content);
    const size = new TextEncoder().encode(input.content).byteLength;
    const { data } = await this.postJson(`${this.config.ingestUrl}/files`, {
      runId: this.config.runId,
      path: input.path,
      kind: "text",
      mimeType: input.mimeType ?? "text/markdown",
      size,
      contentHash,
      content: input.content,
    });
    const file = asRecord(data.file);
    const eventSeq = input.eventSeq ?? this.nextSeq();
    await this.postRunEvent({
      seq: eventSeq,
      type: "file_written",
      payload: {
        fileId: stringField(file.id) ?? input.path,
        path: stringField(file.path) ?? input.path,
        size: numberField(file.size) ?? size,
        contentHash: stringField(file.contentHash) ?? contentHash,
      },
    });
    return { file, eventSeq };
  }

  async createOrUpdateArtifact(input: {
    title: string;
    kind: string;
    path?: string;
    contentSnapshot?: string;
    storageKey?: string;
    artifactId?: string;
    eventSeq?: number;
  }): Promise<{ artifact: ControlPlaneJson; eventSeq: number }> {
    const eventSeq = input.eventSeq ?? this.nextSeq();
    const { data } = await this.postJson(`${this.config.ingestUrl}/artifacts`, {
      runId: this.config.runId,
      ...(input.artifactId ? { artifactId: input.artifactId } : {}),
      title: input.title,
      kind: input.kind,
      ...(input.path ? { path: input.path } : {}),
      ...(input.contentSnapshot ? { contentSnapshot: input.contentSnapshot } : {}),
      ...(input.storageKey ? { storageKey: input.storageKey } : {}),
      eventSeq,
    });
    return { artifact: asRecord(data.artifact), eventSeq };
  }

  private async postJson(
    url: string,
    body: ControlPlaneJson,
  ): Promise<{ data: ControlPlaneJson; envelope: ControlPlaneJson }> {
    const response = await this.transport(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.runToken}`,
      },
      body: JSON.stringify(body),
    });
    const envelope = asRecord(await response.json().catch(() => ({})));
    if (!response.ok) {
      throw new PiRuntimeControlPlaneError(
        stringField(envelope.message) ?? `Control Plane request failed: ${response.status}`,
        response.status,
        new URL(url).pathname,
      );
    }
    if (envelope.code !== 0) {
      throw new PiRuntimeControlPlaneError(
        stringField(envelope.message) ?? "Control Plane returned non-zero code",
        response.status,
        new URL(url).pathname,
      );
    }
    return { data: asRecord(envelope.data), envelope };
  }
}

export function asRecord(value: unknown): ControlPlaneJson {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as ControlPlaneJson;
}

export function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

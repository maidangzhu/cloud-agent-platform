import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cap/db";
import { buildPiRuntimeStartConfig } from "./config.js";
import { issueRunToken } from "../run/run-token.js";
import { resolveVercelCredentials } from "../sandbox/vercel-credentials.js";
import {
  deleteRunStream,
  readRunStream,
} from "../redis/streams.js";
import {
  getOrCreateWorkspaceSandbox,
  releaseWorkspaceSandboxForRun,
  runPiRuntimeInSandbox,
  type WorkspaceSandboxClaim,
} from "../sandbox/workspace-sandbox.js";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const HAS_SECRET = Boolean(process.env.BETTER_AUTH_SECRET);
const HAS_VERCEL = Boolean(resolveVercelCredentials());
const RUN_REAL_PROVIDER_GATE = process.env.CAP_RUN_REAL_PROVIDER_GATE === "1";
const PUBLIC_API_BASE_URL =
  process.env.PUBLIC_AGENT_LOOP_BASE_URL ??
  process.env.CAP_API_BASE_URL ??
  process.env.INGEST_BASE_URL ??
  process.env.API_BASE_URL ??
  process.env.PUBLIC_API_BASE_URL ??
  process.env.PUBLIC_INGEST_BASE_URL ??
  publicUrlOrUndefined(process.env.BETTER_AUTH_URL);

describe.skipIf(!HAS_DB || !HAS_SECRET || !HAS_VERCEL || !PUBLIC_API_BASE_URL)(
  "Pi runtime Vercel Sandbox smoke",
  () => {
    const suiteId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const created = {
      userIds: [] as string[],
      workspaceIds: [] as string[],
      threadIds: [] as string[],
      runIds: [] as string[],
      sandboxes: [] as WorkspaceSandboxClaim["sandbox"][],
    };

    afterAll(async () => {
      for (const sandbox of created.sandboxes) {
        await sandbox.stop().catch(() => undefined);
      }
      for (const runId of created.runIds) {
        await deleteRunStream(runId).catch(() => undefined);
        await releaseWorkspaceSandboxForRun(runId, "stopped").catch(() => undefined);
      }
      await prisma.workspaceArtifactVersion.deleteMany({
        where: { runId: { in: created.runIds } },
      });
      await prisma.workspaceArtifact.deleteMany({
        where: { runId: { in: created.runIds } },
      });
      await prisma.workspaceFile.deleteMany({
        where: { workspaceId: { in: created.workspaceIds } },
      });
      await prisma.source.deleteMany({
        where: { workspaceId: { in: created.workspaceIds } },
      });
      await prisma.runEvent.deleteMany({
        where: { runId: { in: created.runIds } },
      });
      await prisma.runToolCall.deleteMany({
        where: { runId: { in: created.runIds } },
      });
      await prisma.agentRun.deleteMany({
        where: { id: { in: created.runIds } },
      });
      await prisma.thread.deleteMany({
        where: { id: { in: created.threadIds } },
      });
      await prisma.workspace.deleteMany({
        where: { id: { in: created.workspaceIds } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: created.userIds } },
      });
      await prisma.$disconnect();
    });

    it(
      "installs Pi packages and calls hosted Control Plane from inside real sandbox",
      async () => {
        const graph = await createGraph(suiteId, created);
        const runToken = issueRunToken({
          userId: graph.userId,
          workspaceId: graph.workspaceId,
          threadId: graph.threadId,
          runId: graph.runId,
          ttlSeconds: 900,
        });
        const claim = await getOrCreateWorkspaceSandbox({
          workspaceId: graph.workspaceId,
          runId: graph.runId,
          timeoutMs: 60_000,
        });
        created.sandboxes.push(claim.sandbox);

        const runPromise = runPiRuntimeInSandbox({
          sandbox: claim.sandbox,
          config: buildPiRuntimeStartConfig({
            apiBaseUrl: PUBLIC_API_BASE_URL!,
            runToken,
            run: {
              id: graph.runId,
              workspaceId: graph.workspaceId,
              threadId: graph.threadId,
              userId: graph.userId,
              prompt: "pi runtime hosted callback smoke",
              maxDurationSec: 180,
            },
            llmProvider: "fake",
            modelHint: "agent-loop-step16",
          }),
          installTimeoutMs: 240_000,
          execTimeoutMs: 120_000,
        });

        const streamEntries = await readRunStream({
          runId: graph.runId,
          cursor: "0",
          blockMs: 120_000,
          count: 10,
        });
        expect(streamEntries.map((entry) => entry.streamType)).toEqual([
          "thinking",
          "content",
        ]);
        expect(streamEntries[0]?.chunk).toContain(
          "pi runtime hosted callback smoke",
        );
        expect(streamEntries[1]?.chunk).toContain(
          "pi runtime hosted callback smoke",
        );
        expect(await prisma.runEvent.count({
          where: {
            runId: graph.runId,
            type: { in: ["agent_thinking", "agent_message"] },
          },
        })).toBe(0);

        const result = await runPromise;

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        const output = parseLastJsonLine(result.stdout);
        expect(output).toMatchObject({
          piRuntimeStarted: true,
          completed: true,
          runId: graph.runId,
          apiBaseUrl: PUBLIC_API_BASE_URL,
          forbiddenEnvPresent: false,
        });
        expect(output.messageCount).toBeGreaterThanOrEqual(2);

        const updated = await prisma.agentRun.findUniqueOrThrow({
          where: { id: graph.runId },
        });
        expect(updated.lastHeartbeatAt).toBeTruthy();
        expect(updated.phase).toBe("finalize");
        expect(updated.status).toBe("completed");

        const events = await prisma.runEvent.findMany({
          where: { runId: graph.runId },
          orderBy: { seq: "asc" },
        });
        expect(events.map((event) => event.type)).toEqual([
          "run_created",
          "runner_started",
          "agent_started",
          "tool_call_started",
          "file_written",
          "artifact_created",
          "tool_call_completed",
          "tool_call_started",
          "tool_call_completed",
          "agent_message",
          "run_completed",
        ]);

        const toolCalls = await prisma.runToolCall.findMany({
          where: { runId: graph.runId },
          orderBy: { startedAt: "asc" },
        });
        expect(toolCalls.map((tool) => `${tool.name}:${tool.status}`)).toEqual(
          expect.arrayContaining(["write_file:completed"]),
        );
        expect(toolCalls.every((tool) => tool.status === "completed")).toBe(true);

        const file = await prisma.workspaceFile.findFirst({
          where: { workspaceId: graph.workspaceId, path: "reports/agent-loop-report.md" },
        });
        expect(file?.latestRunId).toBe(graph.runId);
        expect(file?.content).toContain("pi runtime hosted callback smoke");

        const artifact = await prisma.workspaceArtifact.findFirst({
          where: { runId: graph.runId, path: "reports/agent-loop-report.md" },
        });
        expect(artifact?.version).toBe(1);
        expect(artifact?.contentSnapshot).toContain(
          "pi runtime hosted callback smoke",
        );
      },
      300_000,
	    );

    it.skipIf(!RUN_REAL_PROVIDER_GATE)(
      "streams real provider content to Redis before the final agent message",
      async () => {
        const graph = await createGraph(`${suiteId}-real-stream`, created);
        const runToken = issueRunToken({
          userId: graph.userId,
          workspaceId: graph.workspaceId,
          threadId: graph.threadId,
          runId: graph.runId,
          ttlSeconds: 900,
        });
        const claim = await getOrCreateWorkspaceSandbox({
          workspaceId: graph.workspaceId,
          runId: graph.runId,
          timeoutMs: 60_000,
        });
        created.sandboxes.push(claim.sandbox);

        const runPromise = runPiRuntimeInSandbox({
          sandbox: claim.sandbox,
          config: buildPiRuntimeStartConfig({
            apiBaseUrl: PUBLIC_API_BASE_URL!,
            runToken,
            run: {
              id: graph.runId,
              workspaceId: graph.workspaceId,
              threadId: graph.threadId,
              userId: graph.userId,
              prompt: [
                "Respond directly without using tools.",
                "Write a detailed 800-word explanation of Redis Streams consumer groups.",
              ].join(" "),
              maxDurationSec: 180,
            },
            llmProvider: "real",
            modelHint: "pi-runtime",
            thinkingLevel: "medium",
          }),
          installTimeoutMs: 240_000,
          execTimeoutMs: 180_000,
        });

        const firstEntries = await readRunStream({
          runId: graph.runId,
          cursor: "0",
          blockMs: 120_000,
          count: 10,
        });
        expect(firstEntries.some((entry) => entry.streamType === "content"))
          .toBe(true);
        expect(await prisma.runEvent.count({
          where: { runId: graph.runId, type: "agent_message" },
        })).toBe(0);

        const result = await runPromise;
        expect(result.exitCode, result.stderr || result.stdout).toBe(0);
        expect(result.stderr).toBe("");
        const output = parseLastJsonLine(result.stdout);
        expect(output).toMatchObject({
          piRuntimeStarted: true,
          completed: true,
          runId: graph.runId,
          forbiddenEnvPresent: false,
        });

        const streamEntries = await readAllRunStream(graph.runId);
        const streamedContent = streamEntries
          .filter((entry) => entry.streamType === "content")
          .map((entry) => entry.chunk)
          .join("");
        const events = await prisma.runEvent.findMany({
          where: { runId: graph.runId },
          orderBy: { seq: "asc" },
        });
        const message = events.find((event) => event.type === "agent_message");
        expect(message, JSON.stringify({
          output,
          eventTypes: events.map((event) => event.type),
          streamTypes: streamEntries.map((entry) => entry.streamType),
          streamedContentLength: streamedContent.length,
        })).toBeTruthy();
        expect(streamedContent.length).toBeGreaterThan(100);
        expect(message?.content).toBe(streamedContent);
      },
      300_000,
    );

	    it(
	      "runs filesystem and bash tools inside real sandbox workspace",
	      async () => {
	        const graph = await createGraph(`${suiteId}-tools`, created);
	        const runToken = issueRunToken({
	          userId: graph.userId,
	          workspaceId: graph.workspaceId,
	          threadId: graph.threadId,
	          runId: graph.runId,
	          ttlSeconds: 900,
	        });
	        const claim = await getOrCreateWorkspaceSandbox({
	          workspaceId: graph.workspaceId,
	          runId: graph.runId,
	          timeoutMs: 60_000,
	        });
	        created.sandboxes.push(claim.sandbox);

	        const result = await runPiRuntimeInSandbox({
	          sandbox: claim.sandbox,
	          config: buildPiRuntimeStartConfig({
	            apiBaseUrl: PUBLIC_API_BASE_URL!,
	            runToken,
	            run: {
	              id: graph.runId,
	              workspaceId: graph.workspaceId,
	              threadId: graph.threadId,
	              userId: graph.userId,
	              prompt: "pi runtime filesystem and bash tool smoke",
	              maxDurationSec: 180,
	            },
	            llmProvider: "fake",
	            modelHint: "pi-runtime-tools",
	          }),
	          installTimeoutMs: 240_000,
	          execTimeoutMs: 120_000,
	        });

	        expect(result.exitCode).toBe(0);
	        expect(result.stderr).toBe("");
	        const output = parseLastJsonLine(result.stdout);
	        expect(output).toMatchObject({
	          piRuntimeStarted: true,
	          completed: true,
	          runId: graph.runId,
	          apiBaseUrl: PUBLIC_API_BASE_URL,
	          forbiddenEnvPresent: false,
	        });

	        const updated = await prisma.agentRun.findUniqueOrThrow({
	          where: { id: graph.runId },
	        });
	        expect(updated.status).toBe("completed");

	        const toolCalls = await prisma.runToolCall.findMany({
	          where: { runId: graph.runId },
	          orderBy: { startedAt: "asc" },
	        });
	        expect(toolCalls.map((tool) => `${tool.name}:${tool.status}`)).toEqual([
	          "run_command:completed",
	          "list_directory:completed",
	          "read_file:completed",
	        ]);
	        const runCommand = toolCalls.find((tool) => tool.name === "run_command");
	        const readFile = toolCalls.find((tool) => tool.name === "read_file");
	        expect(JSON.stringify(runCommand?.result)).toContain("maidang-smoke");
	        expect(JSON.stringify(readFile?.result)).toContain("maidang-smoke");
	      },
	      300_000,
	    );

    it(
      "calls hosted search proxy from inside real sandbox workspace",
      async () => {
        const graph = await createGraph(`${suiteId}-search`, created);
        const runToken = issueRunToken({
          userId: graph.userId,
          workspaceId: graph.workspaceId,
          threadId: graph.threadId,
          runId: graph.runId,
          ttlSeconds: 900,
        });
        const claim = await getOrCreateWorkspaceSandbox({
          workspaceId: graph.workspaceId,
          runId: graph.runId,
          timeoutMs: 60_000,
        });
        created.sandboxes.push(claim.sandbox);

        const result = await runPiRuntimeInSandbox({
          sandbox: claim.sandbox,
          config: buildPiRuntimeStartConfig({
            apiBaseUrl: PUBLIC_API_BASE_URL!,
            runToken,
            run: {
              id: graph.runId,
              workspaceId: graph.workspaceId,
              threadId: graph.threadId,
              userId: graph.userId,
              prompt: "agent runtime search",
              maxDurationSec: 180,
            },
            llmProvider: "fake",
            modelHint: "pi-runtime-search",
            searchProvider: "fake",
          }),
          installTimeoutMs: 240_000,
          execTimeoutMs: 120_000,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        const output = parseLastJsonLine(result.stdout);
        expect(output).toMatchObject({
          piRuntimeStarted: true,
          completed: true,
          runId: graph.runId,
          apiBaseUrl: PUBLIC_API_BASE_URL,
          forbiddenEnvPresent: false,
        });

        const toolCalls = await prisma.runToolCall.findMany({
          where: { runId: graph.runId },
          orderBy: { startedAt: "asc" },
        });
        expect(toolCalls.map((tool) => `${tool.name}:${tool.status}`)).toEqual([
          "web_search:completed",
        ]);
        expect(JSON.stringify(toolCalls[0]?.result)).toContain(
          "agent runtime search",
        );

        const sources = await prisma.source.findMany({
          where: { runId: graph.runId, kind: "search_result" },
        });
        expect(sources).toHaveLength(2);
      },
      300_000,
    );

    it(
      "fetches a public URL and records its source from inside real sandbox workspace",
      async () => {
        const graph = await createGraph(`${suiteId}-fetch`, created);
        const runToken = issueRunToken({
          userId: graph.userId,
          workspaceId: graph.workspaceId,
          threadId: graph.threadId,
          runId: graph.runId,
          ttlSeconds: 900,
        });
        const claim = await getOrCreateWorkspaceSandbox({
          workspaceId: graph.workspaceId,
          runId: graph.runId,
          timeoutMs: 60_000,
        });
        created.sandboxes.push(claim.sandbox);

        const result = await runPiRuntimeInSandbox({
          sandbox: claim.sandbox,
          config: buildPiRuntimeStartConfig({
            apiBaseUrl: PUBLIC_API_BASE_URL!,
            runToken,
            run: {
              id: graph.runId,
              workspaceId: graph.workspaceId,
              threadId: graph.threadId,
              userId: graph.userId,
              prompt: "fetch a public page",
              maxDurationSec: 180,
            },
            llmProvider: "fake",
            modelHint: "pi-runtime-fetch",
          }),
          installTimeoutMs: 240_000,
          execTimeoutMs: 120_000,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(parseLastJsonLine(result.stdout)).toMatchObject({
          piRuntimeStarted: true,
          completed: true,
          runId: graph.runId,
          forbiddenEnvPresent: false,
        });

        const toolCalls = await prisma.runToolCall.findMany({
          where: { runId: graph.runId },
          orderBy: { startedAt: "asc" },
        });
        expect(toolCalls.map((tool) => `${tool.name}:${tool.status}`)).toEqual([
          "fetch_url:completed",
        ]);
        expect(JSON.stringify(toolCalls[0]?.result)).toContain(
          "https://example.com/",
        );

        const sources = await prisma.source.findMany({
          where: { runId: graph.runId, kind: "url" },
        });
        expect(sources).toHaveLength(1);
        expect(sources[0]?.uri).toBe("https://example.com");
      },
      300_000,
    );
	  },
	);

function publicUrlOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
      ? undefined
      : value;
  } catch {
    return undefined;
  }
}

async function readAllRunStream(runId: string) {
  const entries = [];
  let cursor = "0";
  while (true) {
    const page = await readRunStream({
      runId,
      cursor,
      blockMs: 100,
      count: 1000,
    });
    entries.push(...page);
    if (page.length < 1000) return entries;
    cursor = page.at(-1)?.id ?? cursor;
  }
}

async function createGraph(
  suiteId: string,
  created: {
    userIds: string[];
    workspaceIds: string[];
    threadIds: string[];
    runIds: string[];
  },
): Promise<{
  userId: string;
  workspaceId: string;
  threadId: string;
  runId: string;
}> {
  const userId = `it-pi-user-${suiteId}`;
  const workspaceId = `it-pi-workspace-${suiteId}`;
  const threadId = `it-pi-thread-${suiteId}`;
  const runId = `it-pi-run-${suiteId}`;
  created.userIds.push(userId);
  created.workspaceIds.push(workspaceId);
  created.threadIds.push(threadId);
  created.runIds.push(runId);

  await prisma.user.create({
    data: {
      id: userId,
      email: `it-pi-runtime-${suiteId}@example.com`,
      name: "Pi Runtime Test User",
    },
  });
  await prisma.workspace.create({
    data: {
      id: workspaceId,
      ownerUserId: userId,
      title: `IT-PiRuntimeWs-${suiteId}`,
    },
  });
  await prisma.thread.create({
    data: {
      id: threadId,
      workspaceId,
      title: "IT-PiRuntimeThread",
    },
  });
  await prisma.agentRun.create({
    data: {
      id: runId,
      workspaceId,
      threadId,
      userId,
      prompt: "pi runtime hosted callback smoke",
      status: "running",
      maxDurationSec: 180,
    },
  });

  return { userId, workspaceId, threadId, runId };
}

function parseLastJsonLine(stdout: string): Record<string, unknown> {
  const line = stdout
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.startsWith("{") && value.endsWith("}"))
    .at(-1);
  if (!line) throw new Error(`no JSON line found in stdout: ${stdout}`);
  return JSON.parse(line) as Record<string, unknown>;
}

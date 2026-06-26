// scripts/audit-session.ts — 离线审计任意 session / run 的全量数据。
//
// 用法：
//   npx tsx scripts/audit-session.ts <sessionId>           # 审计整个 session
//   npx tsx scripts/audit-session.ts <sessionId> --run <runId>
//   npx tsx scripts/audit-session.ts --list-stuck          # 列出所有疑似卡住的 run
//   npx tsx scripts/audit-session.ts --list-stuck --since-min 30
//
// 自动加载 .env。输出 JSON 到 stdout（方便 jq / pipe），可读总结到 stderr。

import { config as loadDotenv } from "dotenv";
loadDotenv();

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { isTerminalRunStatus } from "../src/server/runs/run-status";

// ── Args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const listStuck = argv.includes("--list-stuck");
const sinceIdx = argv.indexOf("--since-min");
const sinceMin = sinceIdx >= 0 ? Number(argv[sinceIdx + 1]) : 30;
const runIdx = argv.indexOf("--run");
const runArg = runIdx >= 0 ? argv[runIdx + 1] : null;
const sessionArg = argv[0] && !argv[0].startsWith("--") ? argv[0] : null;

// ── DB ────────────────────────────────────────────────────────────────────────
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

// ── Helpers ───────────────────────────────────────────────────────────────────
function relTime(d: Date | null | undefined): string {
  if (!d) return "—";
  const ms = Date.now() - d.getTime();
  if (ms < 0) return `in ${(-ms / 1000).toFixed(0)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s ago`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m ago`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h ago`;
  return `${(ms / 86_400_000).toFixed(1)}d ago`;
}

function truncate(s: string | null | undefined, n = 200): string | null {
  if (s == null) return null;
  return s.length > n ? s.slice(0, n) + `…[+${s.length - n}]` : s;
}

function diagnoseStuck(
  run: {
    id: string;
    status: string;
    lastHeartbeatAt: Date | null;
    startedAt: Date | null;
    createdAt: Date;
    completedAt: Date | null;
  },
  lastEvents: { type: string; title: string | null; createdAt: Date; seq: number }[],
): string {
  if (isTerminalRunStatus(run.status as any)) {
    return `terminal: ${run.status}`;
  }
  const sinceLast = run.lastHeartbeatAt
    ? Math.floor((Date.now() - run.lastHeartbeatAt.getTime()) / 1000)
    : null;
  const last = lastEvents[lastEvents.length - 1];
  if (!last) {
    return `no events yet (created ${relTime(run.createdAt)})`;
  }
  const stuckAfterLast = Math.floor((Date.now() - last.createdAt.getTime()) / 1000);
  return [
    `status=${run.status}`,
    `lastHeartbeat=${relTime(run.lastHeartbeatAt)} (${sinceLast ?? "—"}s)`,
    `lastEvent=${last.type}${last.title ? `(${last.title})` : ""}@seq=${last.seq} (${relTime(last.createdAt)}, ${stuckAfterLast}s ago)`,
  ].join(" | ");
}

// ── Core fetchers ─────────────────────────────────────────────────────────────
async function fetchSessionFull(sessionId: string) {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return null;

  const [messages, runs, workspace] = await Promise.all([
    prisma.message.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" },
    }),
    prisma.run.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" },
    }),
    prisma.workspace.findUnique({ where: { sessionId } }),
  ]);

  const runsFull = await Promise.all(
    runs.map(async (r) => {
      const [events, toolCalls, artifacts] = await Promise.all([
        prisma.agentEvent.findMany({
          where: { runId: r.id },
          orderBy: { seq: "asc" },
        }),
        prisma.toolCall.findMany({
          where: { runId: r.id },
          orderBy: { startedAt: "asc" },
        }),
        prisma.artifact.findMany({
          where: { runId: r.id },
          orderBy: { createdAt: "asc" },
        }),
      ]);
      return { ...r, events, toolCalls, artifacts };
    }),
  );

  return { session, messages, workspace, runs: runsFull };
}

async function listStuckRuns(sinceMinutes: number) {
  const candidates = await prisma.run.findMany({
    where: {
      status: { in: ["created", "provisioning_workspace", "running"] },
    },
    include: { Session: { select: { id: true, title: true } } },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  return candidates
    .map((r) => {
      const ref = r.lastHeartbeatAt ?? r.startedAt ?? r.createdAt;
      return { run: r, staleSec: Math.floor((Date.now() - ref.getTime()) / 1000) };
    })
    .filter((x) => x.staleSec > sinceMinutes * 60);
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderSession(payload: NonNullable<Awaited<ReturnType<typeof fetchSessionFull>>>) {
  const { session, messages, workspace, runs } = payload;
  return {
    session: {
      id: session.id,
      title: session.title,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      age: relTime(session.createdAt),
    },
    workspace: workspace
      ? {
          id: workspace.id,
          provider: workspace.provider,
          status: workspace.status,
          sandboxName: workspace.sandboxName,
          workingDir: workspace.workingDir,
          snapshotId: workspace.snapshotId,
          snapshotExpiresAt: workspace.snapshotExpiresAt,
          error: workspace.error,
          updatedAt: workspace.updatedAt,
        }
      : null,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: truncate(m.content, 400),
      runId: m.runId,
      createdAt: m.createdAt,
    })),
    runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      userPrompt: truncate(r.userPrompt, 200),
      maxSteps: r.maxSteps,
      maxDurationSec: r.maxDurationSec,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      lastHeartbeatAt: r.lastHeartbeatAt,
      error: r.error,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      age: relTime(r.createdAt),
      diagnosis: diagnoseStuck(r, r.events),
      eventCount: r.events.length,
      toolCallCount: r.toolCalls.length,
      artifactCount: r.artifacts.length,
      events: r.events.map((e) => ({
        seq: e.seq,
        type: e.type,
        role: e.role,
        title: e.title,
        content: e.content ? truncate(e.content, 300) : null,
        rawSummary: e.raw ? truncate(JSON.stringify(e.raw), 1000) : null,
        createdAt: e.createdAt,
      })),
      toolCalls: r.toolCalls.map((t) => ({
        id: t.id,
        eventSeq: t.eventSeq,
        name: t.name,
        status: t.status,
        argsSummary: t.args ? truncate(JSON.stringify(t.args), 600) : null,
        resultSummary: t.result ? truncate(JSON.stringify(t.result), 600) : null,
        error: t.error,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
        durationMs: t.completedAt
          ? t.completedAt.getTime() - t.startedAt.getTime()
          : Date.now() - t.startedAt.getTime(),
      })),
      artifacts: r.artifacts.map((a) => ({
        id: a.id,
        kind: a.kind,
        title: a.title,
        path: a.path,
        contentPreview: a.content ? truncate(a.content, 400) : null,
        createdAt: a.createdAt,
      })),
    })),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (listStuck) {
    const stuck = await listStuckRuns(sinceMin);
    const enriched = await Promise.all(
      stuck.map(async (s) => {
        const first = await prisma.agentEvent.findFirst({
          where: { runId: s.run.id },
          orderBy: { seq: "asc" },
          select: { type: true, createdAt: true },
        });
        const last = await prisma.agentEvent.findFirst({
          where: { runId: s.run.id },
          orderBy: { seq: "desc" },
          select: { type: true, title: true, seq: true, createdAt: true },
        });
        return {
          runId: s.run.id,
          sessionId: s.run.sessionId,
          sessionTitle: s.run.Session.title,
          status: s.run.status,
          staleSec: s.staleSec,
          startedAt: s.run.startedAt,
          lastHeartbeatAt: s.run.lastHeartbeatAt,
          firstEvent: first,
          lastEvent: last,
        };
      }),
    );
    process.stderr.write(
      `\n=== Stuck runs (no heartbeat > ${sinceMin}min) ===\n${enriched.length} run(s)\n\n`,
    );
    process.stdout.write(JSON.stringify(enriched, null, 2));
    return;
  }

  if (!sessionArg) {
    process.stderr.write(
      "Usage:\n" +
        "  npx tsx scripts/audit-session.ts <sessionId> [--run <runId>]\n" +
        "  npx tsx scripts/audit-session.ts --list-stuck [--since-min 30]\n",
    );
    process.exit(1);
  }

  const payload = await fetchSessionFull(sessionArg);
  if (!payload) {
    process.stderr.write(`Session not found: ${sessionArg}\n`);
    process.exit(2);
  }

  if (runArg) {
    const run = payload.runs.find((r) => r.id === runArg);
    if (!run) {
      process.stderr.write(`Run not found in session: ${runArg}\n`);
      process.exit(3);
    }
    process.stdout.write(JSON.stringify({ run }, null, 2));
    return;
  }

  const rendered = renderSession(payload);
  process.stderr.write(
    `\n=== Session ${rendered.session.id} ===\n` +
      `title: ${rendered.session.title}\n` +
      `runs: ${rendered.runs.length}  messages: ${rendered.messages.length}  workspace: ${rendered.workspace?.status ?? "—"}\n\n` +
      `--- Run status ---\n` +
      rendered.runs
        .map(
          (r) =>
            `  [${r.status.padEnd(22)}] ${r.id}  steps=${r.eventCount} tools=${r.toolCallCount}\n` +
            `     diagnosis: ${r.diagnosis}\n` +
            (r.error ? `     error: ${truncate(r.error, 200) ?? ""}\n` : ""),
        )
        .join("\n") +
      "\n\nJSON dumped to stdout.\n",
  );
  process.stdout.write(JSON.stringify(rendered, null, 2));
}

main()
  .catch((e) => {
    console.error("audit failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

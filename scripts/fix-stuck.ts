// 立即把卡住的 run 标为 timeout（watchdog 修复部署前的临时止血）。
// 用法：npx tsx scripts/fix-stuck.ts [runId] (默认当前那条)
import { config as loadDotenv } from "dotenv";
loadDotenv();
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

async function main() {
  const runId = process.argv[2] ?? "3baf6e20-e612-46ab-9607-b3baa7db31a1";
  const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  const r = await p.run.findUnique({ where: { id: runId } });
  if (!r) { console.error("not found"); process.exit(1); }
  if (r.status === "completed" || r.status === "failed" || r.status === "cancelled" || r.status === "timeout") {
    console.log(`run ${runId} already terminal: ${r.status}`);
    return;
  }
  // 找下一个 seq
  const last = await p.agentEvent.findFirst({ where: { runId }, orderBy: { seq: "desc" }, select: { seq: true } });
  const nextSeq = (last?.seq ?? 0) + 1;
  await p.$transaction([
    p.agentEvent.create({
      data: { id: crypto.randomUUID(), runId, seq: nextSeq, type: "run_timeout", content: "manually marked by scripts/fix-stuck.ts" },
    }),
    p.run.update({
      where: { id: runId },
      data: { status: "timeout", error: "stuck no heartbeat > 30min; manual cleanup before watchdog deploy", completedAt: new Date(), lastHeartbeatAt: new Date() },
    }),
  ]);
  console.log(`run ${runId} marked timeout; event seq=${nextSeq}`);
  await p.$disconnect();
}
main();

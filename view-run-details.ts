#!/usr/bin/env tsx
/**
 * 查看 Run 的详细结果
 */

// 加载环境变量
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), ".env.local") });

import { prisma } from "./src/server/db/client";

const runId = process.argv[2];
if (!runId) {
  console.error("使用方式: npx tsx view-run-details.ts <runId>");
  process.exit(1);
}

async function main() {
  console.log(`\n📊 Run 详情: ${runId}\n`);
  console.log("=".repeat(80));

  // 获取 Run 信息
  const run = await prisma.run.findUnique({ where: { id: runId } });
  if (!run) {
    console.error("❌ Run 不存在");
    process.exit(1);
  }

  console.log(`\n状态: ${run.status}`);
  console.log(`用户提示: ${run.userPrompt}`);
  console.log(`创建时间: ${run.createdAt}`);
  console.log(`完成时间: ${run.completedAt || "N/A"}`);
  if (run.error) {
    console.log(`错误: ${run.error}`);
  }

  // 获取所有事件
  const events = await prisma.agentEvent.findMany({
    where: { runId },
    orderBy: { seq: "asc" },
  });

  console.log(`\n📋 事件总数: ${events.length}\n`);
  console.log("=".repeat(80));

  for (const event of events) {
    console.log(`\n[${event.seq}] ${event.type.toUpperCase()}`);
    console.log(`时间: ${event.createdAt.toISOString()}`);

    if (event.type === "workspace_ready") {
      console.log(`✓ Workspace 就绪`);
    } else if (event.type === "agent_started") {
      console.log(`✓ Agent 启动`);
    } else if (event.type === "tool_call_started") {
      const payload = event.payload as any;
      console.log(`🔧 工具调用开始`);
      console.log(`   Payload: ${payload ? JSON.stringify(payload).slice(0, 200) : "null"}`);
    } else if (event.type === "tool_call_completed") {
      const payload = event.payload as any;
      console.log(`✓ 工具完成`);
      console.log(`   Payload: ${payload ? JSON.stringify(payload).slice(0, 300) : "null"}`);
    } else if (event.type === "model_step") {
      const payload = event.payload as any;
      console.log(`💬 模型响应 (${payload?.role || "unknown"})`);
      if (payload?.content) {
        const preview = payload.content.slice(0, 500);
        console.log(`\n${preview}${payload.content.length > 500 ? "\n..." : ""}`);
      }
    } else if (event.type === "artifact_created") {
      const payload = event.payload as any;
      console.log(`📄 Artifact: ${payload?.title || "无标题"}`);
      console.log(`   类型: ${payload?.type || "unknown"}`);
      if (payload?.content) {
        const preview = payload.content.slice(0, 300);
        console.log(`   内容: ${preview}${payload.content.length > 300 ? "..." : ""}`);
      }
    } else if (event.type === "run_completed") {
      console.log(`✅ Run 完成`);
    } else if (event.type === "run_failed") {
      const payload = event.payload as any;
      console.log(`❌ Run 失败: ${payload?.error || "未知错误"}`);
    }

    console.log("-".repeat(80));
  }

  // 获取 Messages
  const messages = await prisma.message.findMany({
    where: { sessionId: run.sessionId },
    orderBy: { createdAt: "asc" },
  });

  console.log(`\n💬 会话消息: ${messages.length} 条\n`);
  console.log("=".repeat(80));

  for (const msg of messages) {
    console.log(`\n[${msg.role.toUpperCase()}] ${msg.createdAt.toISOString()}`);
    const preview = msg.content.slice(0, 500);
    console.log(`${preview}${msg.content.length > 500 ? "\n..." : ""}`);
    console.log("-".repeat(80));
  }

  // 获取 Artifacts
  const artifacts = await prisma.artifact.findMany({
    where: { runId },
    orderBy: { createdAt: "asc" },
  });

  if (artifacts.length > 0) {
    console.log(`\n📦 Artifacts: ${artifacts.length} 个\n`);
    console.log("=".repeat(80));

    for (const artifact of artifacts) {
      console.log(`\n标题: ${artifact.title}`);
      console.log(`类型: ${artifact.type}`);
      console.log(`创建时间: ${artifact.createdAt.toISOString()}`);
      console.log(`\n内容:\n`);
      console.log(artifact.content);
      console.log("\n" + "=".repeat(80));
    }
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("❌ 错误:", err);
  process.exit(1);
});

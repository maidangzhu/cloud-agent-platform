#!/usr/bin/env tsx
/**
 * 手动测试主链路：创建 session → 发送 prompt → 监听 SSE 事件流
 *
 * 测试用例：执行 npx maidang，了解麦当的技术背景和项目经验
 */

const API_BASE = "http://localhost:3000";
const INVITE_CODE = "maidangzhu"; // 测试邀请码

interface SessionResponse {
  code: number;
  data: {
    session: {
      id: string;
      title: string;
      status: string;
      createdAt: string;
    };
  };
}

interface RunResponse {
  code: number;
  data: {
    run: {
      id: string;
      sessionId: string;
      userPrompt: string;
      status: string;
      createdAt: string;
    };
  };
}

async function createSession(prompt: string): Promise<string> {
  console.log("📝 创建 Session...");
  const res = await fetch(`${API_BASE}/api/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-invite-code": INVITE_CODE,
    },
    body: JSON.stringify({ inviteCode: INVITE_CODE, prompt }),
  });

  if (!res.ok) {
    throw new Error(`创建 Session 失败: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as SessionResponse;
  const sessionId = data.data.session.id;
  console.log(`✓ Session 创建成功: ${sessionId}\n`);
  return sessionId;
}

async function createRun(sessionId: string, prompt: string): Promise<string> {
  console.log("🚀 创建 Run...");
  console.log(`Prompt: ${prompt}\n`);

  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });

  if (!res.ok) {
    throw new Error(`创建 Run 失败: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as RunResponse;
  const runId = data.data.run.id;
  console.log(`✓ Run 创建成功: ${runId}`);
  console.log(`状态: ${data.data.run.status}\n`);
  return runId;
}

async function streamEvents(runId: string): Promise<void> {
  console.log("📡 开始监听 SSE 事件流...\n");
  console.log("=" .repeat(80));

  const res = await fetch(`${API_BASE}/api/runs/${runId}/events`, {
    method: "GET",
    headers: { accept: "text/event-stream" },
  });

  if (!res.ok) {
    throw new Error(`获取事件流失败: ${res.status} ${await res.text()}`);
  }

  if (!res.body) {
    throw new Error("响应没有 body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventCount = 0;
  let lastEventTime = Date.now();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.log("\n" + "=".repeat(80));
        console.log("✓ 流结束");
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop() || "";

      for (const chunk of lines) {
        if (!chunk.trim()) continue;

        const eventMatch = chunk.match(/^event:\s*(.+)$/m);
        const dataMatch = chunk.match(/^data:\s*(.+)$/m);

        if (!eventMatch || !dataMatch) continue;

        const eventType = eventMatch[1];
        const eventData = JSON.parse(dataMatch[1]);

        eventCount++;
        const now = Date.now();
        const elapsed = ((now - lastEventTime) / 1000).toFixed(2);
        lastEventTime = now;

        console.log(`\n[${eventCount}] ${eventType.toUpperCase()} (+${elapsed}s)`);

        if (eventType === "snapshot") {
          console.log(`  Run状态: ${eventData.run.status}`);
          console.log(`  历史事件: ${eventData.events.length} 条`);
        } else if (eventType === "ping") {
          console.log(`  ❤️  心跳`);
        } else if (eventType === "done") {
          console.log(`  ✅ 任务完成`);
        } else if (eventType === "agent.thinking") {
          console.log(`  🤔 思考中...`);
          if (eventData.content) {
            const preview = eventData.content.slice(0, 150);
            console.log(`     ${preview}${eventData.content.length > 150 ? "..." : ""}`);
          }
        } else if (eventType === "agent.message") {
          console.log(`  💬 Agent 消息:`);
          const preview = eventData.content?.slice(0, 200) || "";
          console.log(`     ${preview}${(eventData.content?.length || 0) > 200 ? "..." : ""}`);
        } else if (eventType === "tool.call") {
          console.log(`  🔧 工具调用: ${eventData.name}`);
          console.log(`     参数: ${JSON.stringify(eventData.input || {}).slice(0, 100)}`);
        } else if (eventType === "tool.result") {
          console.log(`  ✓ 工具结果: ${eventData.name}`);
          if (eventData.output) {
            const preview = JSON.stringify(eventData.output).slice(0, 150);
            console.log(`     输出: ${preview}...`);
          }
        } else if (eventType === "run.completed") {
          console.log(`  ✅ Run 完成`);
          console.log(`     状态: ${eventData.status}`);
        } else if (eventType === "run.failed") {
          console.log(`  ❌ Run 失败`);
          console.log(`     错误: ${eventData.error}`);
        } else {
          console.log(`  📦 数据: ${JSON.stringify(eventData).slice(0, 100)}...`);
        }

        console.log("-".repeat(80));
      }
    }
  } catch (err) {
    console.error("\n❌ 流处理错误:", err);
    throw err;
  } finally {
    reader.releaseLock();
  }
}

async function main() {
  console.clear();
  console.log("🧪 测试主链路：npx maidang\n");
  console.log("=" .repeat(80));

  const prompt = `Execute the command "npx maidang whoami --json" and then tell me:
- Who is maidang?
- What are his recent projects?
- What is his tech stack?

Please summarize the information in a readable format.`;

  try {
    const sessionId = await createSession(prompt);
    const runId = await createRun(sessionId, prompt);
    await streamEvents(runId);

    console.log("\n✅ 测试完成");
    console.log(`Session ID: ${sessionId}`);
    console.log(`Run ID: ${runId}`);
    console.log(`查看详情: ${API_BASE}/sessions/${sessionId}`);
  } catch (err) {
    console.error("\n❌ 测试失败:", err);
    process.exit(1);
  }
}

main();

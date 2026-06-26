// 测试当前 .env 里两个渠道商（OPENAI_* 和 OPENAI_*2）。
// 对每个 channel 的 primary + fallback 各发一次简单 ping，记录响应时间/状态/content。
// 运行：npx tsx scripts/ping-channels.ts

import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const env = parseEnv(readFileSync(".env", "utf8"));

interface ChannelConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  primary: string;
  fallback: string;
}

const channels: ChannelConfig[] = [];
for (let i = 1; i <= 10; i++) {
  const suffix = i === 1 ? "" : String(i);
  const baseUrl = env[`OPENAI_BASE_URL${suffix}`]?.trim();
  const apiKey = env[`OPENAI_API_KEY${suffix}`]?.trim();
  const primary = env[`LLM_MODEL${suffix}`]?.trim();
  const fallback = env[`LLM_MODEL_FALLBACK${suffix}`]?.trim();
  if (!baseUrl || !apiKey || !primary) break;
  channels.push({
    name: `channel ${i}`,
    baseUrl,
    apiKey,
    primary,
    fallback: fallback || primary,
  });
}

if (channels.length === 0) {
  console.log("没找到任何渠道配置（OPENAI_* / OPENAI_*2）。");
  process.exit(1);
}

const PROMPT = "Reply with exactly one word: pong";
const MAX_TOKENS = 256;

async function ping(label: string, baseUrl: string, apiKey: string, model: string): Promise<void> {
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: PROMPT }],
        max_tokens: MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const elapsed = Date.now() - start;
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 300) };
    }
    const p = parsed as {
      choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning_content?: string } }>;
      error?: { message?: string };
    };
    const choice = p.choices?.[0];
    const content = choice?.message?.content ?? choice?.message?.reasoning_content ?? "";
    const finish = choice?.finish_reason;
    const errMsg = p.error?.message;
    const ok = res.status === 200 && content.trim().length > 0 && finish === "stop";
    console.log(
      `  ${ok ? "✓" : "✗"} ${label.padEnd(30)} status=${res.status} ${String(elapsed).padStart(5)}ms  finish=${finish ?? "-"}  content=${JSON.stringify(content).slice(0, 60)}${errMsg ? `  err=${errMsg.slice(0, 80)}` : ""}`,
    );
  } catch (err) {
    console.log(`  ✗ ${label.padEnd(30)} ERR ${Date.now() - start}ms  ${String(err).slice(0, 150)}`);
  }
}

async function main() {
  console.log(`找到 ${channels.length} 个渠道：\n`);
  for (const ch of channels) {
    console.log(`${ch.name}  (baseUrl: ${ch.baseUrl})`);
    await ping("primary", ch.baseUrl, ch.apiKey, ch.primary);
    if (ch.fallback !== ch.primary) {
      await ping("fallback", ch.baseUrl, ch.apiKey, ch.fallback);
    }
    console.log("");
  }
}

main();
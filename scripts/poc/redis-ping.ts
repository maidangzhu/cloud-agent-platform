// PoC 脚本：验证 Upstash Redis（REDIS_URL）基础连通性 + Streams 能力。
// 不是正式功能代码，跑完确认通了就可以删除或忽略——正式的 Redis 客户端封装
// （带重试、错误处理、TS 类型）留给 ADR-0021 对应的实现 Phase 再写。
//
// 用法：pnpm tsx scripts/poc/redis-ping.ts
// 依赖：.env 或 .env.local 里的 REDIS_URL

import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import Redis from "ioredis";

// 复用 tests/load-env.ts 同样的加载顺序：.env → .env.local，后者覆盖前者。
for (const file of [".env", ".env.local"]) {
  try {
    const parsed = parseEnv(
      fs.readFileSync(path.join(process.cwd(), file), "utf8"),
    );
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value !== "") {
        process.env[key] = value;
      }
    }
  } catch {
    // 文件不存在则忽略
  }
}

async function main() {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.error("缺少 REDIS_URL，请在 .env 或 .env.local 中设置。");
    process.exit(1);
  }

  console.log("连接 Redis...");
  const redis = new Redis(url, {
    maxRetriesPerRequest: 3,
    // Upstash 用 rediss:// (TLS)，ioredis 会自动识别协议并启用 TLS。
  });

  try {
    // 1. 基础连通性：SET / GET
    const key = `poc:ping:${Date.now()}`;
    await redis.set(key, "hello-redis", "EX", 30);
    const value = await redis.get(key);
    if (value !== "hello-redis") {
      throw new Error(`SET/GET 往返值不匹配，收到: ${value}`);
    }
    console.log("✅ SET/GET OK");

    // 2. Streams 能力：XADD / XREAD（对应 ADR-0021 的 token 转发原语）
    const streamKey = `poc:stream:${Date.now()}`;
    const id1 = await redis.xadd(streamKey, "*", "chunk", "hello", "type", "thinking");
    const id2 = await redis.xadd(streamKey, "*", "chunk", "world", "type", "thinking");
    console.log(`✅ XADD OK，写入 2 条 entry (${id1}, ${id2})`);

    // 从头读取（cursor = "0"），验证能读到刚写入的历史 entry。
    const entries = await redis.xrange(streamKey, "-", "+");
    if (entries.length !== 2) {
      throw new Error(`XRANGE 期望 2 条，实际 ${entries.length} 条`);
    }
    console.log(`✅ XRANGE OK，读到 ${entries.length} 条 entry`);

    // 从指定 cursor（第一条的 id）之后读取，验证 cursor 续读语义。
    const afterFirst = await redis.xrange(streamKey, `(${id1}`, "+");
    if (afterFirst.length !== 1 || afterFirst[0][0] !== id2) {
      throw new Error("cursor 续读结果不符合预期");
    }
    console.log("✅ cursor 续读 OK（从 Last-Event-ID 之后继续读取）");

    // 清理测试数据。
    await redis.del(key, streamKey);
    console.log("✅ 清理完成");

    console.log("\n全部通过：Redis 基础连通 + Streams 能力可用。");
  } finally {
    redis.disconnect();
  }
}

main().catch((err) => {
  console.error("❌ 失败:", err);
  process.exit(1);
});

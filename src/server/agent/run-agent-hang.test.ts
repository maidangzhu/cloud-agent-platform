// 直击 run-agent 集成：LLM 永不返回，验证 run-agent 能在合理时间内终止
// 不依赖真实 DB/sandbox（mock 整个 prisma + sandbox factory）
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// in-memory Prisma
class FakePrisma {
  runs = new Map<string, any>();
  events = new Map<string, any[]>();
  workspaces = new Map<string, any>();
  run = {
    findUnique: vi.fn(async ({ where, select }: any) => {
      const r = this.runs.get(where.id);
      if (!r) return null;
      if (select) {
        const out: any = {};
        for (const k of Object.keys(select)) out[k] = r[k];
        return out;
      }
      return { ...r };
    }),
    findUniqueOrThrow: vi.fn(async ({ where }: any) => this.runs.get(where.id)),
    create: vi.fn(async ({ data }: any) => {
      const r = { ...data, status: data.status ?? "created", lastHeartbeatAt: null, startedAt: null, completedAt: null, error: null, createdAt: new Date(), updatedAt: new Date() };
      this.runs.set(r.id, r);
      this.events.set(r.id, []);
      return r;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const r = this.runs.get(where.id);
      if (r) Object.assign(r, data);
      return r;
    }),
  };
  agentEvent = {
    findMany: vi.fn(async () => []),
    findFirst: vi.fn(async () => null),
    create: vi.fn(async ({ data }: any) => {
      const ev = { ...data, createdAt: new Date() };
      this.events.get(data.runId)!.push(ev);
      return ev;
    }),
  };
  toolCall = { create: vi.fn(), update: vi.fn() };
  artifact = { create: vi.fn() };
  message = { create: vi.fn(), findMany: vi.fn(async () => []) };
  workspace = {
    findUnique: vi.fn(async () => null),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const w = { ...(create ?? {}), ...(update ?? {}), sessionId: where.sessionId, updatedAt: new Date() };
      this.workspaces.set(where.sessionId, w);
      return w;
    }),
  };
  $transaction = vi.fn(async (ops: any[]) => {
    const out = [];
    for (const op of ops) out.push(await op);
    return out;
  });
  $disconnect = vi.fn();
}

let fakePrisma: FakePrisma;
vi.mock("../db/client", () => ({
  prisma: new Proxy({} as any, { get: (_, p) => (fakePrisma as any)[p] }),
}));

vi.mock("../sandbox/factory", () => ({
  getOrCreateSandbox: vi.fn(async () => ({
    sandbox: {
      getState: () => ({ provider: "fake", sandboxName: "x" }),
      workingDir: "/tmp",
      readFile: async () => "",
      writeFile: async () => {},
      readdir: async () => [],
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "", truncated: false }),
      snapshot: async () => ({ snapshotId: "s" }),
      stop: async () => {},
    },
  })),
}));

vi.mock("../agent/model", () => ({
  resolveModelChain: () => [
    { key: "k1", channel: 1, tier: "primary", model: { id: "m1", api: "openai-completions", provider: "relay", baseUrl: "x" }, apiKey: "k" },
  ],
  resolvePrimaryModelId: () => "m1",
}));

// Fake Agent：模拟真 Pi 的关键行为 ——
// 1) 构造时接收 streamFn
// 2) prompt() 调 streamFn(model, ctx, { signal }) → for await stream
// 3) 收到 abort signal → 退出 for await → prompt 返回
// 4) abort() 触发 abort controller
class FakeAgent {
  state: any = { messages: [], errorMessage: undefined };
  options: any = {};
  private _abortController = new AbortController();
  constructor(opts: any) {
    this.options = opts;
  }
  abort() {
    this._abortController.abort();
  }
  async prompt(promptStr: string): Promise<any> {
    const streamFn = this.options.streamFn;
    const ctx = { systemPrompt: "", messages: [{ role: "user", content: promptStr, timestamp: Date.now() }], tools: [] };
    // 用 fake model 调 streamFn
    const model = this.options.initialState?.model;
    const stream = streamFn(model, ctx, { signal: this._abortController.signal });
    // 调 for await；如果 stream 永不 emit，则永远不返回 —— 模拟 LLM hang
    let sawError = false;
    try {
      for await (const ev of stream) {
        if (ev.type === "error") {
          sawError = true;
          this.state.errorMessage = ev.error?.errorMessage;
        }
        if (this._abortController.signal.aborted) break;
      }
    } catch (err) {
      this.state.errorMessage = String(err);
    }
    // 模拟：abort 后状态 message
    if (this._abortController.signal.aborted) {
      this.state.errorMessage = "aborted";
    }
    return;
  }
  subscribe() {}
}
vi.mock("@earendil-works/pi-agent-core", () => ({ Agent: FakeAgent }));

describe("run-agent LLM hang 兜底", () => {
  beforeEach(() => { fakePrisma = new FakePrisma(); });
  afterEach(() => { vi.useRealTimers(); });

  it("LLM 永不返回：run-agent 在 attempt duration × 2 + 余量 内把 run 标 failed", async () => {
    const { runAgent } = await import("./run-agent");

    // 准备一个 run
    const run = await fakePrisma.run.create({
      data: { id: crypto.randomUUID(), sessionId: "s1", userPrompt: "hello" },
    });

    // 短超时让测试快
    const FIRST_TOKEN_TIMEOUT = 200;
    const MAX_RETRIES = 1;
    const ATTEMPT_DURATION_MS = 400;
    const MAX_DURATION_SEC = 3; // 3s 兜底

    // llmStreamFn 返回一个永不 emit 的 stream —— 模拟 LLM 上游永远不返回
    // 注意 abort signal 触发时这个 stream 会怎样？它内部什么也不做 —— 上层 abort handler 在 retry/fallback 层
    // 我们的测试关心：llmStreamFn 完全不响应 signal，是否仍能兜住
    const llmStreamFn: any = () => {
      // 真正的 AssistantMessageEventStream，但永不 push
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise(() => {}), // 永远不 resolve
        }),
        result: () => new Promise(() => {}), // 永远不 resolve
        push: () => {},
        end: () => {},
      };
    };

    const t0 = Date.now();
    const promise = runAgent({
      runId: run.id,
      sessionId: "s1",
      userPrompt: "hello",
      llmStreamFn,
      llmFirstResponseTimeoutMs: FIRST_TOKEN_TIMEOUT,
      llmFirstResponseMaxRetries: MAX_RETRIES,
      maxDurationSec: MAX_DURATION_SEC,
    });

    // 期望：3s 内跑完（firstTokenTimeout 触发，retry 1 次 = 2 attempts = 400ms，但 maxDurationSec=3s 兜底）
    const timeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error(`HANG: run-agent not finished after 5s. status=${fakePrisma.runs.get(run.id)?.status}`)), 5000),
    );
    await Promise.race([promise, timeout]);

    const elapsed = Date.now() - t0;
    const finalRun = fakePrisma.runs.get(run.id);
    const events = fakePrisma.events.get(run.id) || [];
    const types = events.map((e: any) => e.type);
    console.log(`[run-agent-hang] elapsed=${elapsed}ms status=${finalRun.status} error=${finalRun.error?.slice(0, 80)}`);
    console.log(`[run-agent-hang] event types: ${types.join(", ")}`);

    // 必须跑完（不能 hang）
    // status 应该是 failed（因为 LLM 永远不返回 + agent.prompt 永不 resolve → run-agent 走 failed 分支）
    // OR：watchdog maxDuration 5s 触发 → status=timeout
    expect(["failed", "timeout"]).toContain(finalRun.status);
    expect(elapsed).toBeLessThan(3500);
  });
});

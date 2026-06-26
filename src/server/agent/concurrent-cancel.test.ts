// 5 并发 run：每个 LLM stream 永不返回；不 cancel，让自然链耗尽。
// 验证：5 个 run 都在合理时间内 status=failed（链耗尽），不 hang。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

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

class FakeAgent {
  state: any = { messages: [], errorMessage: undefined };
  options: any = {};
  private _abortController = new AbortController();
  constructor(opts: any) { this.options = opts; }
  abort() { this._abortController.abort(); }
  async prompt(promptStr: string): Promise<any> {
    const streamFn = this.options.streamFn;
    const ctx = { systemPrompt: "", messages: [{ role: "user", content: promptStr, timestamp: Date.now() }], tools: [] };
    const model = this.options.initialState?.model;
    const stream = streamFn(model, ctx, { signal: this._abortController.signal });
    try {
      for await (const ev of stream) {
        if (ev.type === "error") this.state.errorMessage = ev.error?.errorMessage;
        if (this._abortController.signal.aborted) break;
      }
    } catch (err) {
      this.state.errorMessage = String(err);
    }
    if (this._abortController.signal.aborted) this.state.errorMessage = "aborted";
  }
  subscribe() {}
}
vi.mock("@earendil-works/pi-agent-core", () => ({ Agent: FakeAgent }));

describe("concurrent × 5 永不返回的 LLM", () => {
  beforeEach(() => { fakePrisma = new FakePrisma(); });
  afterEach(() => { vi.useRealTimers(); });

  it("5 并发 run × 永不返回的 stream：所有 run 在 ~1.5s 内 status=failed，不 hang", async () => {
    const { runAgent } = await import("./run-agent");

    const llmStreamFn: any = () => ({
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      result: () => new Promise(() => {}),
      push: () => {}, end: () => {},
    });

    const N = 5;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const r = await fakePrisma.run.create({ data: { id: crypto.randomUUID(), sessionId: "s1", userPrompt: `p${i}` } });
      ids.push(r.id);
    }

    const t0 = Date.now();
    const promises = ids.map((id) =>
      runAgent({
        runId: id, sessionId: "s1", userPrompt: `p`,
        llmStreamFn,
        llmFirstResponseTimeoutMs: 200,
        llmFirstResponseMaxRetries: 1,
        maxDurationSec: 5,
      }),
    );

    // 等所有 promise 完，限 5s
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5000));
    const result = await Promise.race([Promise.all(promises).then(() => "all done"), timeout]);
    const elapsed = Date.now() - t0;

    console.log(`[concurrent-5] result=${result} elapsed=${elapsed}ms`);

    expect(result).toBe("all done");
    expect(elapsed).toBeLessThan(3000);
    // 每个 run 都应 status=failed
    for (const id of ids) {
      const r = fakePrisma.runs.get(id);
      console.log(`  ${id.slice(0,6)} status=${r.status} events=${(fakePrisma.events.get(id) || []).map((e:any)=>e.type).join(",")}`);
      expect(r.status).toBe("failed");
    }
  }, 10000);
});

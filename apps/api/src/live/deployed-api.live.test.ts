import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

const DEPLOYED_API_BASE_URL = (
  process.env.CAP_API_BASE_URL ??
  process.env.API_BASE_URL ??
  process.env.PUBLIC_API_BASE_URL ??
  process.env.PUBLIC_AGENT_LOOP_BASE_URL ??
  ""
).replace(/\/$/, "");
const LIVE_TEST_EMAIL =
  process.env.CAP_LIVE_TEST_EMAIL ?? process.env.LIVE_TEST_EMAIL ?? "";
const LIVE_TEST_PASSWORD =
  process.env.CAP_LIVE_TEST_PASSWORD ?? process.env.LIVE_TEST_PASSWORD ?? "";
const WEB_ORIGIN = process.env.CAP_WEB_ORIGIN ?? "https://sandbox.maidang.me";
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "timeout",
  "cancelled",
  "interrupted",
]);

async function deployedFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${DEPLOYED_API_BASE_URL}${path}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
  });
}

async function deployedJson<T = Record<string, unknown>>(
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; body: T }> {
  const response = await deployedFetch(path, {
    ...init,
    headers: {
      Origin: WEB_ORIGIN,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as T;
  return { response, body };
}

async function expectUnauthorized(path: string, init?: RequestInit) {
  const { response, body } = await deployedJson(path, init);
  expect(response.status).toBe(401);
  expect(body).toMatchObject({
    code: 1002,
    message: "unauthorized",
    data: null,
  });
}

async function authenticateLiveTestUser(): Promise<string> {
  if (!LIVE_TEST_EMAIL || !LIVE_TEST_PASSWORD) {
    const email = `cap-live-${Date.now()}-${randomUUID()}@example.test`;
    const password = `CapLive-${randomUUID()}-Aa1!`;
    const { response, body } = await deployedJson("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({
        name: "CAP Live Test",
        email,
        password,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `live test sign-up failed: ${response.status} ${JSON.stringify(body)}`,
      );
    }
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("live test sign-up did not set a session cookie");
    return cookie;
  }

  const { response, body } = await deployedJson("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({
      email: LIVE_TEST_EMAIL,
      password: LIVE_TEST_PASSWORD,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `live test sign-in failed: ${response.status} ${JSON.stringify(body)}`,
    );
  }
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("live test sign-in did not set a session cookie");
  return cookie;
}

type RunDetailBody = {
  data?: {
    run?: { id: string; status: string; error?: string };
    events?: Array<{ type: string; seq: number }>;
    toolCalls?: Array<{ name: string; status: string }>;
    artifacts?: Array<{ id: string; title: string; path?: string }>;
    sources?: unknown[];
  };
};

async function waitForTerminalRun(
  runId: string,
  cookie: string,
): Promise<RunDetailBody> {
  const deadline = Date.now() + 180_000;
  let latest: RunDetailBody = {};

  while (Date.now() < deadline) {
    const detail = await deployedJson<RunDetailBody>(`/api/runs/${runId}`, {
      headers: { cookie },
    });
    expect(detail.response.status).toBe(200);
    latest = detail.body;
    const status = latest.data?.run?.status;
    if (status && TERMINAL_RUN_STATUSES.has(status)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(
    `run ${runId} did not reach terminal status; last detail: ${JSON.stringify(
      latest,
    )}`,
  );
}

describe.skipIf(!DEPLOYED_API_BASE_URL)(
  "Deployed API live contract（公网 API，无破坏性写入）",
  () => {
    it("GET /health returns ok from deployed API", async () => {
      const res = await deployedFetch("/health");

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ ok: true });
    });

    it("GET /api/health returns ok through API-prefixed proxy paths", async () => {
      const res = await deployedFetch("/api/health");

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
    });

    it("OPTIONS /api/me allows browser credentials from the web origin", async () => {
      const res = await deployedFetch("/api/me", {
        method: "OPTIONS",
        headers: {
          Origin: "https://sandbox.maidang.me",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Content-Type,Authorization",
        },
      });

      expect([200, 204]).toContain(res.status);
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
      expect(res.headers.get("access-control-allow-origin")).toBe(
        "https://sandbox.maidang.me",
      );
    });

    it("rejects unauthenticated browser endpoints with stable envelopes", async () => {
      await expectUnauthorized("/api/me");
      await expectUnauthorized("/api/workspaces");
      await expectUnauthorized("/api/usage/records");
      await expectUnauthorized(`/api/workspaces/${randomUUID()}/threads`);
      await expectUnauthorized(`/api/threads/${randomUUID()}`);
      await expectUnauthorized(`/api/runs/${randomUUID()}`);
      await expectUnauthorized(`/api/workspaces/${randomUUID()}/files`);
      await expectUnauthorized(`/api/workspaces/${randomUUID()}/artifacts`);
      await expectUnauthorized(`/api/workspaces/${randomUUID()}/sources`);
    });

    it("rejects sandbox-scoped endpoints without run tokens", async () => {
      const llm = await deployedJson("/api/llm-proxy", {
        method: "POST",
        body: JSON.stringify({
          runId: randomUUID(),
          messages: [{ role: "user", content: "live unauth check" }],
          provider: "fake",
        }),
      });
      expect(llm.response.status).toBe(401);
      expect([1002, 2002]).toContain((llm.body as { code?: number }).code);
      expect(llm.body).toMatchObject({ data: null });

      const search = await deployedJson("/api/search-proxy", {
        method: "POST",
        body: JSON.stringify({
          runId: randomUUID(),
          query: "live unauth check",
          provider: "fake",
        }),
      });
      expect(search.response.status).toBe(401);
      expect([1002, 2002]).toContain((search.body as { code?: number }).code);
      expect(search.body).toMatchObject({ data: null });
    });
  },
);

describe.skipIf(!DEPLOYED_API_BASE_URL)(
  "Deployed API live workflow smoke（公网 API，真实账号会话）",
  () => {
  it("signs in and exercises workspace/thread/run/read-only resource APIs", async () => {
    const cookie = await authenticateLiveTestUser();
    const title = `LIVE-Workflow-${Date.now()}`;
    let workspaceId = "";
    let threadId = "";
    let runId = "";

    try {
      const workspace = await deployedJson<{
        data?: { workspace?: { id: string; title: string } };
      }>("/api/workspaces", {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({ title }),
      });
      expect(workspace.response.status).toBe(200);
      workspaceId = workspace.body.data?.workspace?.id ?? "";
      expect(workspaceId).toBeTruthy();
      expect(workspace.body.data?.workspace?.title).toBe(title);

      const workspaces = await deployedJson<{
        data?: { workspaces?: Array<{ id: string; title: string }> };
      }>("/api/workspaces", { headers: { cookie } });
      expect(workspaces.response.status).toBe(200);
      expect(workspaces.body.data?.workspaces?.map((w) => w.id)).toContain(
        workspaceId,
      );

      const workspaceDetail = await deployedJson<{
        data?: { workspace?: { id: string; title: string } };
      }>(`/api/workspaces/${workspaceId}`, { headers: { cookie } });
      expect(workspaceDetail.response.status).toBe(200);
      expect(workspaceDetail.body.data?.workspace).toMatchObject({
        id: workspaceId,
        title,
      });

      const renamedTitle = `${title}-Renamed`;
      const renamed = await deployedJson<{
        data?: { workspace?: { id: string; title: string } };
      }>(`/api/workspaces/${workspaceId}`, {
        method: "PATCH",
        headers: { cookie },
        body: JSON.stringify({ title: renamedTitle }),
      });
      expect(renamed.response.status).toBe(200);
      expect(renamed.body.data?.workspace).toMatchObject({
        id: workspaceId,
        title: renamedTitle,
      });

      const thread = await deployedJson<{
        data?: { thread?: { id: string; workspaceId: string; title: string } };
      }>(`/api/workspaces/${workspaceId}/threads`, {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({
          title: `${title}-Thread`,
          initialPrompt: "live deployed workflow smoke",
        }),
      });
      expect(thread.response.status).toBe(200);
      threadId = thread.body.data?.thread?.id ?? "";
      expect(threadId).toBeTruthy();
      expect(thread.body.data?.thread?.workspaceId).toBe(workspaceId);

      const threads = await deployedJson<{
        data?: { threads?: Array<{ id: string; workspaceId: string }> };
      }>(`/api/workspaces/${workspaceId}/threads`, { headers: { cookie } });
      expect(threads.response.status).toBe(200);
      expect(threads.body.data?.threads?.map((t) => t.id)).toContain(threadId);

      const threadDetail = await deployedJson<{
        data?: {
          thread?: { id: string; workspaceId: string };
          messages?: unknown[];
          runs?: unknown[];
        };
      }>(`/api/threads/${threadId}`, { headers: { cookie } });
      expect(threadDetail.response.status).toBe(200);
      expect(threadDetail.body.data?.thread).toMatchObject({
        id: threadId,
        workspaceId,
      });
      expect(Array.isArray(threadDetail.body.data?.messages)).toBe(true);
      expect(Array.isArray(threadDetail.body.data?.runs)).toBe(true);

      const run = await deployedJson<{
        data?: { run?: { id: string; status: string; prompt: string } };
      }>(`/api/threads/${threadId}/runs`, {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({ prompt: "live deployed run smoke" }),
      });
      expect(run.response.status).toBe(200);
      runId = run.body.data?.run?.id ?? "";
      expect(runId).toBeTruthy();
      expect(run.body.data?.run?.status).toBe("created");

      const detail = await deployedJson<{
        data?: {
          run?: { id: string; status: string };
          events?: unknown[];
          toolCalls?: unknown[];
          artifacts?: unknown[];
          sources?: unknown[];
        };
      }>(`/api/runs/${runId}`, { headers: { cookie } });
      expect(detail.response.status).toBe(200);
      expect(detail.body.data?.run).toMatchObject({
        id: runId,
      });
      expect(Array.isArray(detail.body.data?.events)).toBe(true);
      expect(Array.isArray(detail.body.data?.toolCalls)).toBe(true);
      expect(Array.isArray(detail.body.data?.artifacts)).toBe(true);
      expect(Array.isArray(detail.body.data?.sources)).toBe(true);

      const files = await deployedJson<{
        data?: { files?: unknown[] };
      }>(`/api/workspaces/${workspaceId}/files`, { headers: { cookie } });
      expect(files.response.status).toBe(200);
      expect(Array.isArray(files.body.data?.files)).toBe(true);

      const artifacts = await deployedJson<{
        data?: { artifacts?: unknown[] };
      }>(`/api/workspaces/${workspaceId}/artifacts`, { headers: { cookie } });
      expect(artifacts.response.status).toBe(200);
      expect(Array.isArray(artifacts.body.data?.artifacts)).toBe(true);

      const sources = await deployedJson<{
        data?: { sources?: unknown[] };
      }>(`/api/workspaces/${workspaceId}/sources`, { headers: { cookie } });
      expect(sources.response.status).toBe(200);
      expect(Array.isArray(sources.body.data?.sources)).toBe(true);

      const usage = await deployedJson<{
        data?: { records?: unknown[]; pagination?: { limit: number; offset: number } };
      }>("/api/usage/records?limit=5", { headers: { cookie } });
      expect(usage.response.status).toBe(200);
      expect(Array.isArray(usage.body.data?.records)).toBe(true);
      expect(usage.body.data?.pagination).toMatchObject({ limit: 5, offset: 0 });

      const missingWorkspace = await deployedJson(`/api/workspaces/${randomUUID()}`, {
        headers: { cookie },
      });
      expect(missingWorkspace.response.status).toBe(404);
      expect(missingWorkspace.body).toMatchObject({
        code: 1004,
        message: "not found",
        data: null,
      });
    } finally {
      if (runId) {
        await deployedFetch(`/api/runs/${runId}/cancel`, {
          method: "POST",
          headers: { cookie },
        }).catch(() => undefined);
      }
      if (threadId) {
        await deployedFetch(`/api/threads/${threadId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", cookie },
          body: JSON.stringify({ status: "archived" }),
        }).catch(() => undefined);
      }
      if (workspaceId) {
        await deployedFetch(`/api/workspaces/${workspaceId}`, {
          method: "DELETE",
          headers: { cookie },
        }).catch(() => undefined);
      }
    }
  });

  it(
    "creates a hosted run that uses Pi tools and persists files/artifacts through ingest",
    async () => {
      const cookie = await authenticateLiveTestUser();
      const title = `LIVE-Pi-E2E-${Date.now()}`;
      const expectedPath = `reports/${title}.md`;
      let workspaceId = "";
      let threadId = "";
      let runId = "";

      try {
        const workspace = await deployedJson<{
          data?: { workspace?: { id: string; title: string } };
        }>("/api/workspaces", {
          method: "POST",
          headers: { cookie },
          body: JSON.stringify({ title }),
        });
        expect(workspace.response.status).toBe(200);
        workspaceId = workspace.body.data?.workspace?.id ?? "";
        expect(workspaceId).toBeTruthy();

        const thread = await deployedJson<{
          data?: { thread?: { id: string; workspaceId: string } };
        }>(`/api/workspaces/${workspaceId}/threads`, {
          method: "POST",
          headers: { cookie },
          body: JSON.stringify({
            title: `${title}-Thread`,
            initialPrompt: "hosted Pi runtime e2e",
          }),
        });
        expect(thread.response.status).toBe(200);
        threadId = thread.body.data?.thread?.id ?? "";
        expect(threadId).toBeTruthy();

        const run = await deployedJson<{
          data?: { run?: { id: string; status: string } };
        }>(`/api/threads/${threadId}/runs`, {
          method: "POST",
          headers: { cookie },
          body: JSON.stringify({
            prompt: [
              "Production E2E validation: you must use the write_file tool",
              `to create ${expectedPath} with a short markdown report,`,
              "then use the create_artifact tool for that same path.",
              "Do not answer with only plain text.",
            ].join(" "),
          }),
        });
        expect(run.response.status).toBe(200);
        runId = run.body.data?.run?.id ?? "";
        expect(runId).toBeTruthy();

        const detail = await waitForTerminalRun(runId, cookie);
        expect(detail.data?.run?.status).toBe("completed");
        expect(detail.data?.events?.map((event) => event.type)).toEqual(
          expect.arrayContaining([
            "run_created",
            "runner_started",
            "agent_started",
            "file_written",
            "run_completed",
          ]),
        );
        expect(detail.data?.toolCalls?.map((toolCall) => toolCall.name)).toEqual(
          expect.arrayContaining(["write_file"]),
        );
        expect(
          detail.data?.toolCalls?.every(
            (toolCall) => toolCall.status === "completed",
          ),
        ).toBe(true);
        expect(detail.data?.artifacts?.map((artifact) => artifact.path)).toContain(
          expectedPath,
        );

        const files = await deployedJson<{
          data?: { files?: Array<{ path: string; kind: string }> };
        }>(`/api/workspaces/${workspaceId}/files`, { headers: { cookie } });
        expect(files.response.status).toBe(200);
        expect(files.body.data?.files).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: expectedPath, kind: "text" }),
          ]),
        );

        const content = await deployedJson<{
          data?: { content?: string };
        }>(
          `/api/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(
            expectedPath,
          )}`,
          { headers: { cookie } },
        );
        expect(content.response.status).toBe(200);
        expect((content.body.data?.content ?? "").length).toBeGreaterThan(0);

        const artifacts = await deployedJson<{
          data?: { artifacts?: Array<{ id: string; path?: string }> };
        }>(`/api/workspaces/${workspaceId}/artifacts`, {
          headers: { cookie },
        });
        expect(artifacts.response.status).toBe(200);
        const artifact = artifacts.body.data?.artifacts?.find(
          (item) => item.path === expectedPath,
        );
        expect(artifact?.id).toBeTruthy();

        const artifactDetail = await deployedJson<{
          data?: { artifact?: { id: string; path?: string } };
        }>(`/api/artifacts/${artifact?.id}`, { headers: { cookie } });
        expect(artifactDetail.response.status).toBe(200);
        expect(artifactDetail.body.data?.artifact).toMatchObject({
          id: artifact?.id,
          path: expectedPath,
        });
      } finally {
        if (runId) {
          await deployedFetch(`/api/runs/${runId}/cancel`, {
            method: "POST",
            headers: { cookie, Origin: WEB_ORIGIN },
          }).catch(() => undefined);
        }
        if (threadId) {
          await deployedFetch(`/api/threads/${threadId}`, {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              cookie,
              Origin: WEB_ORIGIN,
            },
            body: JSON.stringify({ status: "archived" }),
          }).catch(() => undefined);
        }
        if (workspaceId) {
          await deployedFetch(`/api/workspaces/${workspaceId}`, {
            method: "DELETE",
            headers: { cookie, Origin: WEB_ORIGIN },
          }).catch(() => undefined);
        }
      }
    },
    240_000,
  );
});

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
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as T;
  return { response, body };
}

async function signInLiveTestUser(): Promise<string> {
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

describe.skipIf(!DEPLOYED_API_BASE_URL)(
  "Deployed API live smoke（公网 API，无破坏性写入）",
  () => {
    it("GET /health returns ok from deployed API", async () => {
      const res = await deployedFetch("/health");

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
    });

    it("GET /api/me rejects unauthenticated request with stable envelope", async () => {
      const res = await deployedFetch("/api/me");

      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({
        code: 1002,
        message: "unauthorized",
        data: null,
      });
    });
  },
);

describe.skipIf(
  !DEPLOYED_API_BASE_URL || !LIVE_TEST_EMAIL || !LIVE_TEST_PASSWORD,
)("Deployed API live workflow smoke（公网 API，专用测试账号）", () => {
  it("signs in, creates workspace/thread/run, then cancels and archives through public APIs", async () => {
    const cookie = await signInLiveTestUser();
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
        data?: { run?: { id: string; status: string } };
      }>(`/api/runs/${runId}`, { headers: { cookie } });
      expect(detail.response.status).toBe(200);
      expect(detail.body.data?.run).toMatchObject({
        id: runId,
        status: "created",
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
});

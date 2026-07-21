"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ResearchShell } from "@/components/research/research-shell";
import { ResearchSidebar } from "@/components/research/research-sidebar";
import type { AuthRequest } from "@/components/research/auth-panel";
import type {
  AgentRun,
  CurrentUser,
  LoadState,
  RunArtifact,
  RunSource,
  RunUsageRecord,
  Thread,
  ThreadMessage,
  Workspace,
} from "@/components/research/types";
import {
  chatReducer,
  initialChatState,
  runPollDelayMs,
  selectActiveRun,
  selectIsRunActive,
  type RunEventDTO,
  type ThreadRun,
} from "@/lib/chat-runtime";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

type ApiEnvelope<T> = {
  code: number;
  message: string;
  data: T | null;
};

type ThreadSnapshot = {
  thread: Thread;
  messages: ThreadMessage[];
  runs: ThreadRun[];
};

type RunSnapshot = {
  run: AgentRun;
  events: RunEventDTO[];
  toolCalls: unknown[];
  artifacts: RunArtifact[];
  sources: RunSource[];
};

type UsageSnapshot = {
  records: RunUsageRecord[];
};

export function AppShell() {
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [error, setError] = useState("");
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const [chat, dispatchChat] = useReducer(chatReducer, initialChatState);
  const threadLoadRequestId = useRef(0);

  async function loadWorkspace(nextWorkspaceId?: string | null) {
    setLoadState("loading");
    setError("");
    try {
      const me = await apiGet<{ user: CurrentUser }>("/api/me");
      if (me.status === 401) {
        setUser(null);
        setWorkspaces([]);
        setThreads([]);
        setActiveWorkspaceId(null);
        setActiveThreadId(null);
        dispatchChat({ type: "thread/cleared" });
        setLoadState("unauthorized");
        return;
      }
      if (!me.ok) throw new Error(me.message);
      setUser(me.data.user);

      const workspaceResult = await apiGet<{ workspaces: Workspace[] }>(
        "/api/workspaces"
      );
      if (!workspaceResult.ok) throw new Error(workspaceResult.message);

      const nextWorkspaces = workspaceResult.data.workspaces;
      setWorkspaces(nextWorkspaces);
      const requestedWorkspaceId =
        nextWorkspaceId && nextWorkspaces.some((item) => item.id === nextWorkspaceId)
          ? nextWorkspaceId
          : null;
      const currentWorkspaceId =
        activeWorkspaceId && nextWorkspaces.some((item) => item.id === activeWorkspaceId)
          ? activeWorkspaceId
          : null;
      const selectedWorkspaceId =
        requestedWorkspaceId ??
        currentWorkspaceId ??
        nextWorkspaces.find((item) => item.status === "active")?.id ??
        null;
      setActiveWorkspaceId(selectedWorkspaceId);

      if (!selectedWorkspaceId) {
        setThreads([]);
        setActiveThreadId(null);
        dispatchChat({ type: "thread/cleared" });
        setLoadState("ready");
        return;
      }

      const threadResult = await apiGet<{ threads: Thread[] }>(
        `/api/workspaces/${selectedWorkspaceId}/threads`
      );
      if (!threadResult.ok) throw new Error(threadResult.message);

      const nextThreads = threadResult.data.threads;
      setThreads(nextThreads);
      const storedThreadId = readStoredThreadId(selectedWorkspaceId);
      setActiveThreadId((current) =>
        current && nextThreads.some((thread) => thread.id === current)
          ? current
          : storedThreadId && nextThreads.some((thread) => thread.id === storedThreadId)
            ? storedThreadId
            : null
      );
      setLoadState("ready");
    } catch (err) {
      setLoadState("error");
      setError(toErrorMessage(err));
    }
  }

  useEffect(() => {
    void loadWorkspace();
    // The initial workspace request intentionally runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const requestId = ++threadLoadRequestId.current;
    if (!activeThreadId) {
      dispatchChat({ type: "thread/cleared" });
      return;
    }
    dispatchChat({ type: "thread/loading", threadId: activeThreadId });
    void loadThread(activeThreadId, requestId);
    // Thread loading is driven only by selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

  useEffect(() => {
    if (activeWorkspaceId && activeThreadId) {
      storeThreadId(activeWorkspaceId, activeThreadId);
    }
  }, [activeThreadId, activeWorkspaceId]);

  const activeRunView = selectActiveRun(chat);
  const activeRun = activeRunView?.run ?? null;
  const shouldPoll = selectIsRunActive(activeRun);

  useEffect(() => {
    if (!activeRun || !shouldPoll) return;

    let cancelled = false;
    let timer: number | undefined;
    const runId = activeRun.id;
    const threadId = activeRun.threadId;
    const startedAt = Date.now();
    dispatchChat({ type: "sse/connecting", runId });

    const scheduleNext = () => {
      if (cancelled) return;
      const delay =
        document.visibilityState === "hidden"
          ? 20_000
          : runPollDelayMs(Date.now() - startedAt);
      timer = window.setTimeout(() => void reconcile(), delay);
    };

    const reconcile = async () => {
      try {
        const result = await apiGet<RunSnapshot>(`/api/runs/${runId}`);
        if (!result.ok) throw new Error(result.message);
        if (cancelled) return;
        dispatchChat({
          type: "run/detail_loaded",
          threadId,
          run: result.data.run,
          events: result.data.events,
          artifacts: result.data.artifacts,
          sources: result.data.sources,
        });
        dispatchChat({ type: "sse/open", runId });

        if (!selectIsRunActive(result.data.run)) {
          dispatchChat({
            type: "sse/done",
            runId,
            status: result.data.run.status,
          });
          void loadRunDetail(runId, threadId);
          void refreshThreadHistory(threadId, threadLoadRequestId.current);
          return;
        }
      } catch (err) {
        if (!cancelled) {
          dispatchChat({
            type: "sse/error",
            runId,
            error: `${toErrorMessage(err)} Retrying...`,
          });
        }
      }
      scheduleNext();
    };

    void reconcile();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // Status changes only matter when they cross the active/terminal boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun?.id, shouldPoll]);

  const activeWorkspace = useMemo(
    () => workspaces.find((item) => item.id === activeWorkspaceId) ?? null,
    [activeWorkspaceId, workspaces]
  );
  const activeThread = useMemo(
    () => threads.find((item) => item.id === activeThreadId) ?? null,
    [activeThreadId, threads]
  );

  async function authenticate(request: AuthRequest) {
    setError("");
    const path =
      request.mode === "sign-in"
        ? "/api/auth/sign-in/email"
        : "/api/auth/sign-up/email";
    try {
      const response = await fetch(path, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          request.mode === "sign-in"
            ? { email: request.email, password: request.password }
            : { email: request.email, password: request.password, name: request.name }
        ),
      });
      if (!response.ok) throw new Error(await readAuthError(response));
      await loadWorkspace();
      return true;
    } catch (err) {
      setLoadState("unauthorized");
      setError(toErrorMessage(err));
      return false;
    }
  }

  async function signOut() {
    setError("");
    await fetch("/api/auth/sign-out", {
      method: "POST",
      credentials: "include",
    }).catch(() => undefined);
    if (activeWorkspaceId) clearStoredThreadId(activeWorkspaceId);
    setUser(null);
    setWorkspaces([]);
    setThreads([]);
    setActiveWorkspaceId(null);
    setActiveThreadId(null);
    dispatchChat({ type: "thread/cleared" });
    setLoadState("unauthorized");
  }

  async function createThread() {
    if (!activeWorkspaceId) return;
    setIsCreatingThread(true);
    try {
      const result = await apiPost<{ thread: Thread }>(
        `/api/workspaces/${activeWorkspaceId}/threads`,
        { title: "New research thread" }
      );
      if (!result.ok) throw new Error(result.message);
      setThreads((current) => [
        result.data.thread,
        ...current.filter((thread) => thread.id !== result.data.thread.id),
      ]);
      selectThread(result.data.thread.id);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setIsCreatingThread(false);
    }
  }

  async function createThreadForPrompt(prompt: string) {
    if (!activeWorkspaceId) {
      throw new Error("The default workspace is unavailable.");
    }
    const result = await apiPost<{ thread: Thread }>(
      `/api/workspaces/${activeWorkspaceId}/threads`,
      { initialPrompt: prompt }
    );
    if (!result.ok) throw new Error(result.message);
    setThreads((current) => [
      result.data.thread,
      ...current.filter((thread) => thread.id !== result.data.thread.id),
    ]);
    dispatchChat({ type: "thread/loading", threadId: result.data.thread.id });
    setActiveThreadId(result.data.thread.id);
    return result.data.thread;
  }

  function selectThread(threadId: string) {
    if (threadId === activeThreadId) return;
    dispatchChat({ type: "thread/loading", threadId });
    setActiveThreadId(threadId);
  }

  async function loadThread(threadId: string, requestId: number) {
    try {
      const result = await apiGet<ThreadSnapshot>(`/api/threads/${threadId}`);
      if (requestId !== threadLoadRequestId.current) return;
      if (!result.ok) throw new Error(result.message);
      dispatchChat({
        type: "thread/loaded",
        threadId,
        messages: result.data.messages,
        runs: result.data.runs,
      });
      const latestRun = [...result.data.runs].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
      ).at(-1);
      if (latestRun) await loadRunDetail(latestRun.id, threadId);
    } catch (err) {
      if (requestId === threadLoadRequestId.current) {
        dispatchChat({ type: "thread/failed", threadId, error: toErrorMessage(err) });
      }
    }
  }

  async function refreshThreadHistory(threadId: string, requestId: number) {
    const result = await apiGet<ThreadSnapshot>(`/api/threads/${threadId}`);
    if (requestId !== threadLoadRequestId.current || !result.ok) return;
    dispatchChat({
      type: "thread/loaded",
      threadId,
      messages: result.data.messages,
      runs: result.data.runs,
    });
  }

  async function loadRunDetail(runId: string, threadId: string) {
    try {
      const [result, usageResult] = await Promise.all([
        apiGet<RunSnapshot>(`/api/runs/${runId}`),
        apiGet<UsageSnapshot>(
          `/api/usage/records?runId=${encodeURIComponent(runId)}&limit=20`
        ),
      ]);
      if (!result.ok) throw new Error(result.message);
      if (!usageResult.ok) throw new Error(usageResult.message);
      dispatchChat({
        type: "run/detail_loaded",
        threadId,
        run: result.data.run,
        events: result.data.events,
        artifacts: result.data.artifacts,
        sources: result.data.sources,
        usage: usageResult.data.records,
      });
    } catch (err) {
      dispatchChat({
        type: "run/detail_failed",
        threadId,
        error: toErrorMessage(err),
      });
    }
  }

  async function startRun(prompt: string) {
    dispatchChat({ type: "run/starting" });
    try {
      const targetThreadId =
        activeThreadId ?? (await createThreadForPrompt(prompt)).id;
      const result = await apiPost<{ run: AgentRun }>(
        `/api/threads/${targetThreadId}/runs`,
        { prompt }
      );
      if (!result.ok) throw new Error(result.message);
      dispatchChat({ type: "run/created", run: result.data.run });
      await loadRunDetail(result.data.run.id, targetThreadId);
      return true;
    } catch (err) {
      dispatchChat({ type: "run/start_failed", error: toErrorMessage(err) });
      return false;
    }
  }

  async function cancelRun() {
    if (!activeRun) return;
    dispatchChat({ type: "run/cancelling" });
    try {
      const result = await apiPost<{ run: AgentRun }>(
        `/api/runs/${activeRun.id}/cancel`,
        {}
      );
      if (!result.ok) throw new Error(result.message);
      dispatchChat({ type: "run/cancelled", run: result.data.run });
      await loadRunDetail(result.data.run.id, result.data.run.threadId);
    } catch (err) {
      dispatchChat({ type: "run/cancel_failed", error: toErrorMessage(err) });
    }
  }

  return (
    <SidebarProvider>
      <ResearchSidebar
        activeThreadId={activeThreadId}
        activeWorkspaceId={activeWorkspaceId}
        isCreatingThread={isCreatingThread}
        loadState={loadState}
        onCreateThread={createThread}
        onSelectThread={selectThread}
        onSelectWorkspace={(workspaceId) => {
          setActiveWorkspaceId(workspaceId);
          setActiveThreadId(null);
          dispatchChat({ type: "thread/cleared" });
          void loadWorkspace(workspaceId);
        }}
        onSignOut={() => void signOut()}
        threads={threads}
        user={user}
        workspaces={workspaces}
      />

      <SidebarInset>
        <ResearchShell
          activeThread={activeThread}
          activeWorkspace={activeWorkspace}
          chat={chat}
          error={error}
          loadState={loadState}
          onCancelRun={cancelRun}
          onAuthenticate={authenticate}
          onCreateThread={createThread}
          onStartRun={startRun}
        />
      </SidebarInset>
    </SidebarProvider>
  );
}

function threadStorageKey(workspaceId: string) {
  return `research:active-thread:${workspaceId}`;
}

function readStoredThreadId(workspaceId: string) {
  try {
    return window.localStorage.getItem(threadStorageKey(workspaceId));
  } catch {
    return null;
  }
}

function storeThreadId(workspaceId: string, threadId: string) {
  try {
    window.localStorage.setItem(threadStorageKey(workspaceId), threadId);
  } catch {
    // Server state remains authoritative when local storage is unavailable.
  }
}

function clearStoredThreadId(workspaceId: string) {
  try {
    window.localStorage.removeItem(threadStorageKey(workspaceId));
  } catch {
    // Sign-out still clears in-memory state.
  }
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function apiGet<T>(path: string) {
  const response = await fetch(path, {
    credentials: "include",
    cache: "no-store",
  });
  return parseApiResponse<T>(response);
}

async function apiPost<T>(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseApiResponse<T>(response);
}

async function parseApiResponse<T>(response: Response): Promise<
  | { ok: true; status: number; data: T; message: string }
  | { ok: false; status: number; message: string }
> {
  const body = (await response.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!response.ok || !body || body.code !== 0 || !body.data) {
    return {
      ok: false,
      status: response.status,
      message: body?.message ?? `HTTP ${response.status}`,
    };
  }
  return { ok: true, status: response.status, data: body.data, message: body.message };
}

async function readAuthError(response: Response) {
  const body = await response.json().catch(() => null);
  if (body && typeof body === "object" && "message" in body && typeof body.message === "string") {
    return body.message;
  }
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return `HTTP ${response.status}`;
}

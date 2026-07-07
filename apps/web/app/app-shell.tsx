"use client";

import { fetchEventSource } from "@microsoft/fetch-event-source";
import { useEffect, useMemo, useState } from "react";
import { ResearchShell } from "@/components/research/research-shell";
import { ResearchSidebar } from "@/components/research/research-sidebar";
import type { AuthRequest } from "@/components/research/auth-panel";
import type {
  AgentRun,
  CurrentUser,
  LoadState,
  RunArtifact,
  RunSource,
  RunStatus,
  Thread,
  ThreadMessage,
  Workspace,
} from "@/components/research/types";
import type {
  RunEventDTO,
  RunEventType,
  StreamChunkDTO,
} from "@/components/research/run-events";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

type ApiEnvelope<T> = {
  code: number;
  message: string;
  data: T | null;
};

type ThreadSnapshot = {
  thread: Thread;
  messages: ThreadMessage[];
  runs?: AgentRun[];
};

type RunSnapshot = {
  run: AgentRun;
  events: RunEventDTO[];
  toolCalls: unknown[];
  artifacts: RunArtifact[];
  sources: RunSource[];
};

type ClientStreamChunk = StreamChunkDTO & { id: string };

const DEFAULT_WORKSPACE_TITLE = "Research workspace";

const RUN_EVENT_TYPES: RunEventType[] = [
  "run_created",
  "sandbox_provisioning",
  "sandbox_ready",
  "runner_started",
  "agent_started",
  "agent_thinking",
  "agent_message",
  "tool_call_started",
  "tool_call_completed",
  "tool_call_failed",
  "file_written",
  "source_recorded",
  "artifact_started",
  "artifact_delta",
  "artifact_created",
  "artifact_updated",
  "artifact_failed",
  "run_completed",
  "run_failed",
  "run_timeout",
  "run_cancelled",
  "run_waiting_for_input",
];

export function AppShell() {
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState("");
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(
    null
  );
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [isCreatingWorkspace, setIsCreatingWorkspace] = useState(false);
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const [threadMessages, setThreadMessages] = useState<ThreadMessage[]>([]);
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [runEvents, setRunEvents] = useState<RunEventDTO[]>([]);
  const [streamChunks, setStreamChunks] = useState<ClientStreamChunk[]>([]);
  const [runArtifacts, setRunArtifacts] = useState<RunArtifact[]>([]);
  const [runSources, setRunSources] = useState<RunSource[]>([]);
  const [runError, setRunError] = useState("");
  const [isStartingRun, setIsStartingRun] = useState(false);
  const [isCancellingRun, setIsCancellingRun] = useState(false);

  async function loadWorkspaceSnapshot(nextWorkspaceId?: string | null) {
    setState("loading");
    setError("");
    try {
      const me = await apiGet<{ user: CurrentUser }>("/api/me");
      if (me.status === 401) {
        setUser(null);
        setWorkspaces([]);
        setThreads([]);
        setActiveWorkspaceId(null);
        setActiveThreadId(null);
        clearThreadRunState();
        setState("unauthorized");
        return;
      }
      if (!me.ok) {
        throw new Error(me.message);
      }
      setUser(me.data.user);

      const workspaceResult = await apiGet<{ workspaces: Workspace[] }>(
        "/api/workspaces"
      );
      if (!workspaceResult.ok) {
        throw new Error(workspaceResult.message);
      }

      let nextWorkspaces = workspaceResult.data.workspaces;
      if (nextWorkspaces.length === 0) {
        const createdWorkspace = await apiPost<{ workspace: Workspace }>(
          "/api/workspaces",
          { title: DEFAULT_WORKSPACE_TITLE }
        );
        if (!createdWorkspace.ok) {
          throw new Error(createdWorkspace.message);
        }
        nextWorkspaces = [createdWorkspace.data.workspace];
      }

      setWorkspaces(nextWorkspaces);
      const requestedWorkspaceId =
        nextWorkspaceId && nextWorkspaces.some((workspace) => workspace.id === nextWorkspaceId)
          ? nextWorkspaceId
          : null;
      const currentWorkspaceId =
        activeWorkspaceId &&
        nextWorkspaces.some((workspace) => workspace.id === activeWorkspaceId)
          ? activeWorkspaceId
          : null;
      const selectedWorkspaceId =
        requestedWorkspaceId ??
        currentWorkspaceId ??
        nextWorkspaces.find((workspace) => workspace.status === "active")?.id ??
        null;
      setActiveWorkspaceId(selectedWorkspaceId);

      if (!selectedWorkspaceId) {
        setThreads([]);
        setActiveThreadId(null);
        clearThreadRunState();
        setState("ready");
        return;
      }

      const threadResult = await apiGet<{ threads: Thread[] }>(
        `/api/workspaces/${selectedWorkspaceId}/threads`
      );
      if (!threadResult.ok) {
        throw new Error(threadResult.message);
      }

      const nextThreads = threadResult.data.threads;
      setThreads(nextThreads);
      setActiveThreadId((current) =>
        current && nextThreads.some((thread) => thread.id === current)
          ? current
          : (nextThreads[0]?.id ?? null)
      );
      setState("ready");
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void loadWorkspaceSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeThreadId) {
      clearThreadRunState();
      return;
    }
    clearThreadRunState();
    void loadThreadSnapshot(activeThreadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

  useEffect(() => {
    if (!activeRun || isTerminalRunStatus(activeRun.status)) {
      return;
    }

    const controller = new AbortController();

    void fetchEventSource(`/api/runs/${activeRun.id}/events`, {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
      openWhenHidden: true,
      signal: controller.signal,
      async onopen(response) {
        if (!response.ok) {
          throw new Error(`SSE connection failed with HTTP ${response.status}`);
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) {
          throw new Error("SSE connection did not return an event stream.");
        }
        setRunError("");
      },
      onmessage(message) {
        if (message.event === "snapshot") {
          const snapshot = parseSseData<{
            run: AgentRun;
            events: RunEventDTO[];
          }>(message.data);
          if (!snapshot) {
            return;
          }
          setActiveRun(snapshot.run);
          setRunEvents(snapshot.events);
          setStreamChunks([]);
          setRunError("");
          return;
        }

        if (message.event === "stream_chunk") {
          const chunk = parseSseData<StreamChunkDTO>(message.data);
          if (!chunk) {
            return;
          }
          const id = message.id || `${Date.now()}-${Math.random()}`;
          setStreamChunks((current) =>
            current.some((item) => item.id === id)
              ? current
              : [...current, { ...chunk, id }]
          );
          return;
        }

        if (message.event === "done") {
          const done = parseSseData<{ runId: string; status: RunStatus }>(
            message.data
          );
          if (done?.runId === activeRun.id) {
            setActiveRun((current) =>
              current && current.id === done.runId
                ? { ...current, status: done.status }
                : current
            );
            void loadRunSnapshot(done.runId);
          }
          controller.abort();
          return;
        }

        if (message.event === "ping") {
          return;
        }

        if (RUN_EVENT_TYPES.includes(message.event as RunEventType)) {
          const event = parseSseData<RunEventDTO>(message.data);
          if (!event) {
            return;
          }
          setRunEvents((current) => mergeRunEvents(current, [event]));
        }
      },
      onclose() {
        if (!controller.signal.aborted && !isTerminalRunStatus(activeRun.status)) {
          setRunError("Live event stream disconnected; showing last snapshot.");
        }
      },
      onerror(error) {
        if (!controller.signal.aborted && !isTerminalRunStatus(activeRun.status)) {
          setRunError(
            error instanceof Error
              ? error.message
              : "Live event stream disconnected; showing last snapshot."
          );
        }
        return 2_000;
      },
    });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun?.id, activeRun?.status]);

  const activeWorkspace = useMemo(
    () =>
      workspaces.find((workspace) => workspace.id === activeWorkspaceId) ??
      null,
    [activeWorkspaceId, workspaces]
  );
  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
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
            : {
                email: request.email,
                password: request.password,
                name: request.name,
              }
        ),
      });
      if (!response.ok) {
        throw new Error(await readAuthError(response));
      }
      await loadWorkspaceSnapshot();
      return true;
    } catch (err) {
      setState("unauthorized");
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  async function signOut() {
    setError("");
    await fetch("/api/auth/sign-out", {
      method: "POST",
      credentials: "include",
    }).catch(() => undefined);
    setUser(null);
    setWorkspaces([]);
    setThreads([]);
    setActiveWorkspaceId(null);
    setActiveThreadId(null);
    clearThreadRunState();
    setState("unauthorized");
  }

  async function createWorkspace() {
    setIsCreatingWorkspace(true);
    try {
      const result = await apiPost<{ workspace: Workspace }>("/api/workspaces", {
        title: "Untitled workspace",
      });
      if (!result.ok) {
        throw new Error(result.message);
      }
      await loadWorkspaceSnapshot(result.data.workspace.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    } finally {
      setIsCreatingWorkspace(false);
    }
  }

  async function createThread() {
    if (!activeWorkspaceId) {
      return;
    }
    setIsCreatingThread(true);
    try {
      const result = await apiPost<{ thread: Thread }>(
        `/api/workspaces/${activeWorkspaceId}/threads`,
        { title: "New research thread" }
      );
      if (!result.ok) {
        throw new Error(result.message);
      }
      await loadWorkspaceSnapshot(activeWorkspaceId);
      setActiveThreadId(result.data.thread.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    } finally {
      setIsCreatingThread(false);
    }
  }

  async function createThreadForPrompt(prompt: string) {
    if (!activeWorkspaceId) {
      throw new Error("Select or create a workspace before starting a run.");
    }
    const result = await apiPost<{ thread: Thread }>(
      `/api/workspaces/${activeWorkspaceId}/threads`,
      { initialPrompt: prompt }
    );
    if (!result.ok) {
      throw new Error(result.message);
    }
    setThreads((current) => [
      result.data.thread,
      ...current.filter((thread) => thread.id !== result.data.thread.id),
    ]);
    setActiveThreadId(result.data.thread.id);
    return result.data.thread;
  }

  function clearThreadRunState() {
    setThreadMessages([]);
    setActiveRun(null);
    setRunEvents([]);
    setStreamChunks([]);
    setRunArtifacts([]);
    setRunSources([]);
    setRunError("");
  }

  async function loadThreadSnapshot(threadId: string) {
    setRunError("");
    try {
      const result = await apiGet<ThreadSnapshot>(`/api/threads/${threadId}`);
      if (!result.ok) {
        throw new Error(result.message);
      }
      setThreadMessages(result.data.messages);

      const latestRunId =
        [...result.data.messages].reverse().find((message) => message.runId)
          ?.runId ??
        result.data.runs?.[0]?.id ??
        readStoredRunId(threadId);

      if (latestRunId) {
        await loadRunSnapshot(latestRunId);
      } else {
        setActiveRun(null);
        setRunEvents([]);
        setStreamChunks([]);
        setRunArtifacts([]);
        setRunSources([]);
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadRunSnapshot(runId: string) {
    const result = await apiGet<RunSnapshot>(`/api/runs/${runId}`);
    if (!result.ok) {
      throw new Error(result.message);
    }
    setActiveRun(result.data.run);
    setRunEvents(result.data.events);
    setRunArtifacts(result.data.artifacts);
    setRunSources(result.data.sources);
    setRunError("");
    storeRunId(result.data.run.threadId, result.data.run.id);
  }

  async function startRun(prompt: string) {
    setIsStartingRun(true);
    setRunError("");
    try {
      const targetThreadId =
        activeThreadId ?? (await createThreadForPrompt(prompt)).id;
      if (!targetThreadId) {
        throw new Error("Create a workspace before starting a run.");
      }
      const result = await apiPost<{ run: AgentRun }>(
        `/api/threads/${targetThreadId}/runs`,
        { prompt }
      );
      if (!result.ok) {
        throw new Error(result.message);
      }
      setActiveRun(result.data.run);
      setRunEvents([]);
      setStreamChunks([]);
      setRunArtifacts([]);
      setRunSources([]);
      storeRunId(targetThreadId, result.data.run.id);
      await loadRunSnapshot(result.data.run.id);
      return true;
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setIsStartingRun(false);
    }
  }

  async function cancelRun() {
    if (!activeRun) {
      return;
    }
    setIsCancellingRun(true);
    setRunError("");
    try {
      const result = await apiPost<{ run: AgentRun }>(
        `/api/runs/${activeRun.id}/cancel`,
        {}
      );
      if (!result.ok) {
        throw new Error(result.message);
      }
      setActiveRun(result.data.run);
      await loadRunSnapshot(result.data.run.id);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsCancellingRun(false);
    }
  }

  return (
    <SidebarProvider>
      <ResearchSidebar
        activeThreadId={activeThreadId}
        activeWorkspaceId={activeWorkspaceId}
        isCreatingThread={isCreatingThread}
        isCreatingWorkspace={isCreatingWorkspace}
        loadState={state}
        onCreateThread={createThread}
        onCreateWorkspace={createWorkspace}
        onSelectThread={setActiveThreadId}
        onSelectWorkspace={(workspaceId) => {
          setActiveWorkspaceId(workspaceId);
          setActiveThreadId(null);
          void loadWorkspaceSnapshot(workspaceId);
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
          error={error}
          isCancellingRun={isCancellingRun}
          isStartingRun={isStartingRun}
          loadState={state}
          onCancelRun={cancelRun}
          onAuthenticate={authenticate}
          onCreateThread={createThread}
          onCreateWorkspace={createWorkspace}
          onStartRun={startRun}
          run={activeRun}
          runArtifacts={runArtifacts}
          runError={runError}
          runEvents={runEvents}
          runSources={runSources}
          streamChunks={streamChunks}
          threadMessages={threadMessages}
          user={user}
        />
      </SidebarInset>
    </SidebarProvider>
  );
}

function parseSseData<T>(data: string): T | null {
  if (typeof data !== "string") {
    return null;
  }
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

function mergeRunEvents(current: RunEventDTO[], incoming: RunEventDTO[]) {
  const bySeq = new Map<number, RunEventDTO>();
  for (const event of current) {
    bySeq.set(event.seq, event);
  }
  for (const event of incoming) {
    bySeq.set(event.seq, event);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function isTerminalRunStatus(status: RunStatus) {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "timeout" ||
    status === "cancelled" ||
    status === "interrupted" ||
    status === "waiting_for_input"
  );
}

function runStorageKey(threadId: string) {
  return `research:last-run:${threadId}`;
}

function readStoredRunId(threadId: string) {
  try {
    return window.localStorage.getItem(runStorageKey(threadId));
  } catch {
    return null;
  }
}

function storeRunId(threadId: string, runId: string) {
  try {
    window.localStorage.setItem(runStorageKey(threadId), runId);
  } catch {
    // Ignore storage failures; server snapshots remain authoritative.
  }
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
  return {
    ok: true,
    status: response.status,
    data: body.data,
    message: body.message,
  };
}

async function readAuthError(response: Response) {
  const body = await response.json().catch(() => null);
  if (
    body &&
    typeof body === "object" &&
    "message" in body &&
    typeof body.message === "string"
  ) {
    return body.message;
  }
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return `HTTP ${response.status}`;
}

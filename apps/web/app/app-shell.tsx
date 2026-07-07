"use client";

import {
  FileText,
  Fullscreen,
  Loader2,
  PanelRightOpen,
  Plus,
  Search,
  Send,
  Square,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ResearchSidebar } from "@/components/research/research-sidebar";
import type {
  CurrentUser,
  LoadState,
  Thread,
  Workspace,
} from "@/components/research/types";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

type ApiEnvelope<T> = {
  code: number;
  message: string;
  data: T | null;
};

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

  async function loadWorkspaceSnapshot(nextWorkspaceId?: string | null) {
    setState("loading");
    setError("");
    try {
      const me = await apiGet<{ user: CurrentUser }>("/api/me");
      if (me.status === 401) {
        setUser(null);
        setWorkspaces([]);
        setThreads([]);
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

      const nextWorkspaces = workspaceResult.data.workspaces;
      setWorkspaces(nextWorkspaces);
      const selectedWorkspaceId =
        nextWorkspaceId ??
        activeWorkspaceId ??
        nextWorkspaces.find((workspace) => workspace.status === "active")?.id ??
        null;
      setActiveWorkspaceId(selectedWorkspaceId);

      if (!selectedWorkspaceId) {
        setThreads([]);
        setActiveThreadId(null);
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
    // Initial snapshot only. Later steps will move this into a shared data hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        threads={threads}
        user={user}
        workspaces={workspaces}
      />

      <SidebarInset className="h-dvh overflow-hidden">
        <header className="sticky top-0 flex h-14 shrink-0 items-center justify-between gap-2 bg-sidebar px-3">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger className="md:hidden" />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium">
                {activeWorkspace?.title ?? "Research workspace"}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {activeThread?.title ?? headerSubtitle(state)}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <StatusPill state={state} />
            <button
              aria-label="Open artifact panel"
              className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground xl:hidden"
              type="button"
            >
              <PanelRightOpen className="size-4" />
            </button>
          </div>
        </header>

        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background md:rounded-tl-[12px] md:border-l md:border-t md:border-border/40">
          <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(360px,42vw)]">
            <ConversationSurface
              activeThread={activeThread}
              activeWorkspace={activeWorkspace}
              error={error}
              loadState={state}
              onCreateThread={createThread}
              onCreateWorkspace={createWorkspace}
              user={user}
            />
            <ArtifactSurface />
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function ConversationSurface(props: {
  activeWorkspace: Workspace | null;
  activeThread: Thread | null;
  error: string;
  loadState: LoadState;
  onCreateWorkspace: () => void;
  onCreateThread: () => void;
  user: CurrentUser | null;
}) {
  return (
    <section className="relative flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          <SystemBanner {...props} />
          {props.activeThread ? (
            <ThreadPreview
              thread={props.activeThread}
              workspace={props.activeWorkspace}
            />
          ) : (
            <EmptyThreadState
              activeWorkspace={props.activeWorkspace}
              onCreateThread={props.onCreateThread}
              onCreateWorkspace={props.onCreateWorkspace}
            />
          )}
        </div>
      </div>

      <div className="shrink-0 px-3 pb-3 md:px-4 md:pb-4">
        <form className="mx-auto w-full max-w-3xl">
          <div className="rounded-2xl border border-border bg-card p-2 shadow-[var(--shadow-composer)] transition-shadow focus-within:shadow-[var(--shadow-composer-focus)]">
            <label className="sr-only" htmlFor="composer">
              Message
            </label>
            <textarea
              className="max-h-40 min-h-14 w-full resize-none bg-transparent px-2 py-2 text-[13px] leading-6 outline-none placeholder:text-muted-foreground"
              disabled
              id="composer"
              placeholder="Ask what to research next..."
              rows={2}
            />
            <div className="flex items-center justify-between gap-2 px-1 pb-1">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="rounded-md border border-border px-2 py-1">
                  research-default
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  aria-label="Cancel run"
                  className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                  disabled
                  type="button"
                >
                  <Square className="size-4" />
                </button>
                <button
                  aria-label="Send message"
                  className="inline-flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                  disabled
                  type="button"
                >
                  <Send className="size-4" />
                </button>
              </div>
            </div>
          </div>
        </form>
      </div>
    </section>
  );
}

function SystemBanner(props: {
  error: string;
  loadState: LoadState;
  user: CurrentUser | null;
}) {
  if (props.loadState === "unauthorized") {
    return (
      <div className="message-fade-in rounded-2xl border border-border/50 bg-card px-4 py-3 text-[13px] leading-6 shadow-[var(--shadow-card)]">
        <div className="font-medium">Not signed in</div>
        <p className="mt-1 text-muted-foreground">
          Sign in through the API auth flow, then this shell will load your real
          workspaces and threads.
        </p>
      </div>
    );
  }
  if (props.loadState === "error") {
    return (
      <div className="message-fade-in rounded-2xl border border-destructive/30 bg-card px-4 py-3 text-[13px] leading-6 shadow-[var(--shadow-card)]">
        <div className="font-medium text-destructive">API snapshot failed</div>
        <p className="mt-1 text-muted-foreground">{props.error}</p>
      </div>
    );
  }
  if (props.loadState === "loading") {
    return (
      <div className="message-fade-in flex items-center gap-2 rounded-2xl border border-border/50 bg-card px-4 py-3 text-[13px] text-muted-foreground shadow-[var(--shadow-card)]">
        <Loader2 className="size-4 animate-spin" />
        Loading workspace snapshot
      </div>
    );
  }
  return null;
}

function EmptyThreadState(props: {
  activeWorkspace: Workspace | null;
  onCreateWorkspace: () => void;
  onCreateThread: () => void;
}) {
  return (
    <div className="message-fade-in rounded-2xl border border-border/50 bg-card p-5 shadow-[var(--shadow-card)]">
      <div className="text-sm font-medium">
        {props.activeWorkspace ? "No thread selected" : "No workspace selected"}
      </div>
      <p className="mt-1 max-w-xl text-[13px] leading-6 text-muted-foreground">
        {props.activeWorkspace
          ? "Create a thread in this workspace to start the research path."
          : "Create a workspace first; threads and runs belong inside it."}
      </p>
      <div className="mt-4 flex gap-2">
        {props.activeWorkspace ? (
          <button
            className="inline-flex h-8 items-center gap-2 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
            onClick={props.onCreateThread}
            type="button"
          >
            <Plus className="size-4" />
            New thread
          </button>
        ) : (
          <button
            className="inline-flex h-8 items-center gap-2 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
            onClick={props.onCreateWorkspace}
            type="button"
          >
            <Plus className="size-4" />
            New workspace
          </button>
        )}
      </div>
    </div>
  );
}

function ThreadPreview(props: {
  thread: Thread;
  workspace: Workspace | null;
}) {
  return (
    <>
      <div className="message-fade-in flex justify-end">
        <div className="w-fit max-w-[min(80%,56ch)] overflow-hidden break-words rounded-2xl rounded-br-lg border border-border/30 bg-gradient-to-br from-secondary to-muted px-3.5 py-2 text-[13px] leading-[1.65] shadow-[var(--shadow-card)]">
          {props.thread.title}
        </div>
      </div>

      <div className="message-fade-in space-y-3">
        <div className="w-fit max-w-[min(88%,62ch)] rounded-2xl border border-border/50 bg-card px-4 py-3 text-[13px] leading-6 shadow-[var(--shadow-card)]">
          Workspace context is ready. Continue from the composer when this
          thread is ready for the next run.
        </div>
        <ArtifactPreview />
      </div>

      <div className="message-fade-in grid gap-2">
        {[
          ["Workspace", props.workspace?.title ?? "Selected workspace"],
          ["Thread", props.thread.title],
          ["Status", props.thread.status],
        ].map(([label, value]) => (
          <div
            className="flex max-w-[450px] items-center justify-between rounded-xl border border-border/50 bg-card px-3 py-2 text-[13px] shadow-[var(--shadow-card)]"
            key={label}
          >
            <span className="text-muted-foreground">{label}</span>
            <span className="min-w-0 truncate font-medium">{value}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function ArtifactPreview() {
  return (
    <button
      className="relative w-full max-w-[450px] cursor-pointer text-left transition-transform hover:-translate-y-px"
      type="button"
    >
      <div className="absolute left-0 top-0 z-10 size-full rounded-xl">
        <div className="flex w-full items-center justify-end p-4">
          <div className="absolute right-[9px] top-[13px] rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <Fullscreen className="size-4" />
          </div>
        </div>
      </div>
      <div className="flex flex-row items-center justify-between gap-2 rounded-t-2xl border border-b-0 border-border/50 bg-card px-4 py-3">
        <div className="flex min-w-0 flex-row items-center gap-2.5">
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <div className="truncate text-sm font-medium">Artifact preview</div>
        </div>
        <div className="w-8" />
      </div>
      <div className="h-[220px] overflow-hidden rounded-b-2xl border border-t-0 border-border/50 bg-muted p-6">
        <div className="space-y-3">
          <div className="h-4 w-2/3 rounded bg-muted-foreground/15" />
          <div className="h-3 w-full rounded bg-muted-foreground/15" />
          <div className="h-3 w-11/12 rounded bg-muted-foreground/15" />
          <div className="h-3 w-4/5 rounded bg-muted-foreground/15" />
          <div className="mt-5 h-20 rounded-xl border border-border/60 bg-background/70" />
        </div>
      </div>
    </button>
  );
}

function ArtifactSurface() {
  return (
    <aside
      className="hidden min-h-0 border-l border-border/70 bg-card xl:flex xl:flex-col"
      data-testid="artifact"
    >
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border/70 px-4">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium">Artifact</div>
          <div className="truncate text-xs text-muted-foreground">
            Preview surface
          </div>
        </div>
        <button
          aria-label="Search artifact"
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          type="button"
        >
          <Search className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <article className="mx-auto max-w-2xl space-y-5 text-[13px] leading-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-[-0.025em]">
              Artifact preview
            </h1>
            <p className="mt-2 text-muted-foreground">
              Generated reports open here without replacing the conversation.
            </p>
          </div>
          <div className="rounded-2xl border border-border/50 bg-background p-4 shadow-[var(--shadow-card)]">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <FileText className="size-4 text-muted-foreground" />
              Latest report
            </div>
            <div className="space-y-2 text-muted-foreground">
              <p>Overview, source trail, and version history will appear here.</p>
              <p>The conversation remains available while artifacts stay open.</p>
            </div>
          </div>
        </article>
      </div>
    </aside>
  );
}

function StatusPill({ state }: { state: LoadState }) {
  const label =
    state === "ready"
      ? "snapshot"
      : state === "loading"
        ? "loading"
        : state === "unauthorized"
          ? "signed out"
          : state === "error"
            ? "error"
            : "idle";
  return (
    <span className="hidden rounded-lg border border-border/70 px-2 py-1 text-xs text-muted-foreground sm:inline-flex">
      {label}
    </span>
  );
}

function headerSubtitle(state: LoadState) {
  if (state === "loading") {
    return "Loading workspace snapshot";
  }
  if (state === "unauthorized") {
    return "Not signed in";
  }
  if (state === "error") {
    return "API unavailable";
  }
  return "Select or create a thread";
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

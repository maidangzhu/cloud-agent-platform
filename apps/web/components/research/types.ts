export type CurrentUser = {
  id: string;
  email: string;
  name: string;
};

export type Workspace = {
  id: string;
  title: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
};

export type Thread = {
  id: string;
  workspaceId: string;
  title: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
};

export type ThreadMessage = {
  id: string;
  workspaceId: string;
  threadId: string;
  runId?: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type RunStatus =
  | "created"
  | "provisioning_sandbox"
  | "running"
  | "waiting_for_input"
  | "cancel_requested"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled"
  | "interrupted";

export type AgentRun = {
  id: string;
  workspaceId: string;
  threadId: string;
  status: RunStatus;
  prompt: string;
  derivedUiState: string;
  waitingForInput?: { question: string; options?: string[] };
  startedAt?: string;
  completedAt?: string;
  lastHeartbeatAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type RunArtifact = {
  id: string;
  workspaceId: string;
  threadId?: string;
  runId: string;
  title: string;
  kind: "text" | "code" | "sheet" | "image";
  path?: string;
  contentSnapshot?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type RunSource = {
  id: string;
  workspaceId: string;
  runId?: string;
  artifactId?: string;
  kind: "url" | "file" | "command" | "search_result" | "manual";
  uri?: string;
  title?: string;
  contentHash?: string;
  metadata?: unknown;
  createdAt: string;
};

export type LoadState = "idle" | "loading" | "ready" | "unauthorized" | "error";

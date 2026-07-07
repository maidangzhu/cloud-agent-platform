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

export type LoadState = "idle" | "loading" | "ready" | "unauthorized" | "error";

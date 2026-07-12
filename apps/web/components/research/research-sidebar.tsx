"use client";

import {
  ChevronUpIcon,
  FlaskConicalIcon,
  Loader2Icon,
  MessageSquareIcon,
  PenSquareIcon,
  PlusIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import type { CSSProperties, ReactNode } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import type { CurrentUser, LoadState, Thread, Workspace } from "./types";

type ResearchSidebarProps = {
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
  isCreatingWorkspace: boolean;
  isCreatingThread: boolean;
  loadState: LoadState;
  onCreateWorkspace: () => void;
  onCreateThread: () => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onSelectThread: (threadId: string) => void;
  onSignOut: () => void;
  threads: Thread[];
  user: CurrentUser | null;
  workspaces: Workspace[];
};

export function ResearchSidebar({
  activeWorkspaceId,
  activeThreadId,
  isCreatingWorkspace,
  isCreatingThread,
  loadState,
  onCreateWorkspace,
  onCreateThread,
  onSelectWorkspace,
  onSelectThread,
  onSignOut,
  threads,
  user,
  workspaces,
}: ResearchSidebarProps) {
  const { setOpenMobile } = useSidebar();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border px-3 py-3">
        <SidebarMenu>
          <SidebarMenuItem className="flex flex-row items-center justify-between">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <FlaskConicalIcon className="size-4" />
              </div>
              <div className="min-w-0 group-data-[collapsible=icon]:hidden">
                <div className="truncate text-[13px] font-semibold text-sidebar-accent-foreground">
                  Research Workspace
                </div>
                <div className="truncate text-[11px] text-sidebar-foreground/60">
                  Agent workspace
                </div>
              </div>
            </div>
            <div className="group-data-[collapsible=icon]:hidden">
              <SidebarTrigger className="text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" />
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup className="px-2 pt-3">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="h-9 rounded-md bg-sidebar-accent px-2.5 text-[13px] font-medium text-sidebar-accent-foreground hover:bg-sidebar-accent/80"
                  disabled={isCreatingWorkspace}
                  onClick={() => {
                    setOpenMobile(false);
                    onCreateWorkspace();
                  }}
                  tooltip="New Workspace"
                >
                  {isCreatingWorkspace ? (
                    <Loader2Icon className="size-4 animate-spin" />
                  ) : (
                    <PenSquareIcon className="size-4" />
                  )}
                  <span className="font-medium">New workspace</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <WorkspaceThreadNav
          activeThreadId={activeThreadId}
          activeWorkspaceId={activeWorkspaceId}
          isCreatingThread={isCreatingThread}
          loadState={loadState}
          onCreateThread={onCreateThread}
          onSelectThread={(threadId) => {
            setOpenMobile(false);
            onSelectThread(threadId);
          }}
          onSelectWorkspace={(workspaceId) => {
            setOpenMobile(false);
            onSelectWorkspace(workspaceId);
          }}
          threads={threads}
          workspaces={workspaces}
        />
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-2.5">
        <ResearchUserNav onSignOut={onSignOut} user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function WorkspaceThreadNav({
  activeWorkspaceId,
  activeThreadId,
  isCreatingThread,
  loadState,
  onCreateThread,
  onSelectWorkspace,
  onSelectThread,
  threads,
  workspaces,
}: {
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
  isCreatingThread: boolean;
  loadState: LoadState;
  onCreateThread: () => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onSelectThread: (threadId: string) => void;
  threads: Thread[];
  workspaces: Workspace[];
}) {
  return (
    <>
      <SidebarGroup className="px-2 pt-3 group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel className="h-7 px-2 text-[11px] font-medium tracking-normal text-sidebar-foreground/60">Workspaces</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            {loadState === "loading" && <SidebarLoadingRows />}
            {loadState === "unauthorized" && (
              <SidebarEmptyText>Sign in to load your workspaces.</SidebarEmptyText>
            )}
            {loadState === "error" && (
              <SidebarEmptyText>Workspace snapshot failed.</SidebarEmptyText>
            )}
            {loadState === "ready" && workspaces.length === 0 && (
              <SidebarEmptyText>No workspaces yet.</SidebarEmptyText>
            )}
            {workspaces.map((workspace) => (
              <SidebarMenuItem key={workspace.id}>
                <SidebarMenuButton
                  className="h-8 rounded-md px-2 text-[13px] text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground"
                  isActive={workspace.id === activeWorkspaceId}
                  onClick={() => onSelectWorkspace(workspace.id)}
                >
                  <span className="size-1.5 shrink-0 rounded-full bg-current opacity-50" />
                  <span>{workspace.title}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup className="min-h-0 flex-1 px-2 pt-1 group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel className="h-7 px-2 text-[11px] font-medium tracking-normal text-sidebar-foreground/60">Threads</SidebarGroupLabel>
        <SidebarMenuAction
          disabled={!activeWorkspaceId || isCreatingThread}
          onClick={onCreateThread}
          className="top-1.5 rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          title="Create thread"
        >
          {isCreatingThread ? (
            <Loader2Icon className="animate-spin" />
          ) : (
            <PlusIcon />
          )}
          <span className="sr-only">Create thread</span>
        </SidebarMenuAction>
        <SidebarGroupContent>
          <SidebarMenu>
            {threads.length === 0 && (
              <SidebarEmptyText>
                {activeWorkspaceId
                  ? "No threads in this workspace."
                  : "Select a workspace."}
              </SidebarEmptyText>
            )}
            {threads.map((thread) => (
              <WorkspaceThreadNavItem
                isActive={thread.id === activeThreadId}
                key={thread.id}
                onSelect={() => onSelectThread(thread.id)}
                thread={thread}
              />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </>
  );
}

function WorkspaceThreadNavItem({
  thread,
  isActive,
  onSelect,
}: {
  thread: Thread;
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className="h-8 rounded-md px-2 text-[13px] text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground"
        isActive={isActive}
        onClick={onSelect}
      >
        <MessageSquareIcon className="size-3.5 opacity-60" />
        <span>{thread.title}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function ResearchUserNav({
  onSignOut,
  user,
}: {
  onSignOut: () => void;
  user: CurrentUser | null;
}) {
  const { setTheme, resolvedTheme } = useTheme();
  const label = user?.email ?? "Not signed in";

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton className="h-9 rounded-md bg-transparent px-2 text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground">
              <div
                className="size-5 shrink-0 rounded-full ring-1 ring-sidebar-border/50"
                style={{
                  background: user
                    ? `linear-gradient(135deg, oklch(0.62 0.11 ${emailToHue(label)}), oklch(0.48 0.09 ${emailToHue(label) + 40}))`
                    : "oklch(0.12 0 0 / 0.08)",
                }}
              />
              <span className="truncate text-[13px]">{label}</span>
              <ChevronUpIcon className="ml-auto size-3.5 text-sidebar-foreground/50" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-popper-anchor-width) rounded-lg border border-border/60 bg-card/95 shadow-[var(--shadow-float)] backdrop-blur-xl"
            side="top"
          >
            <DropdownMenuItem
              className="cursor-pointer text-[13px]"
              onSelect={() =>
                setTheme(resolvedTheme === "dark" ? "light" : "dark")
              }
            >
              {`Toggle ${resolvedTheme === "light" ? "dark" : "light"} mode`}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="cursor-pointer text-[13px]"
              disabled={!user}
              onSelect={onSignOut}
            >
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function SidebarLoadingRows() {
  return (
    <div className="flex flex-col gap-0.5 px-1">
      {[44, 32, 64].map((width) => (
        <div className="flex h-8 items-center gap-2 rounded-lg px-2" key={width}>
          <div
            className="h-3 max-w-(--skeleton-width) flex-1 animate-pulse rounded-md bg-sidebar-foreground/[0.06]"
            style={
              {
                "--skeleton-width": `${width}%`,
              } as CSSProperties
            }
          />
        </div>
      ))}
    </div>
  );
}

function SidebarEmptyText({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full flex-row items-center justify-center gap-2 px-2 py-1 text-[13px] leading-5 text-sidebar-foreground/60">
      {children}
    </div>
  );
}

function emailToHue(email: string): number {
  let hash = 0;
  for (const char of email) {
    hash = char.charCodeAt(0) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

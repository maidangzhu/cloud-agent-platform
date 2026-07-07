"use client";

import {
  ArchiveIcon,
  ChevronUpIcon,
  Loader2Icon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PanelLeftIcon,
  PenSquareIcon,
  PlusIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import type { CSSProperties, ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  threads,
  user,
  workspaces,
}: ResearchSidebarProps) {
  const { setOpenMobile, toggleSidebar } = useSidebar();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="pb-0 pt-3">
        <SidebarMenu>
          <SidebarMenuItem className="flex flex-row items-center justify-between">
            <div className="group/logo relative flex items-center justify-center">
              <SidebarMenuButton
                className="size-8 items-center justify-center !px-0 group-data-[collapsible=icon]:group-hover/logo:opacity-0"
                onClick={() => setOpenMobile(false)}
                tooltip="Research Workspace Agent"
              >
                <ArchiveIcon className="size-4 text-sidebar-foreground/50" />
                <span className="sr-only">Research Workspace Agent</span>
              </SidebarMenuButton>
              <Tooltip>
                <TooltipTrigger asChild>
                  <SidebarMenuButton
                    className="pointer-events-none absolute inset-0 size-8 opacity-0 group-data-[collapsible=icon]:pointer-events-auto group-data-[collapsible=icon]:group-hover/logo:opacity-100"
                    onClick={() => toggleSidebar()}
                  >
                    <PanelLeftIcon className="size-4" />
                    <span className="sr-only">Open sidebar</span>
                  </SidebarMenuButton>
                </TooltipTrigger>
                <TooltipContent className="hidden md:block" side="right">
                  Open sidebar
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="group-data-[collapsible=icon]:hidden">
              <SidebarTrigger className="text-sidebar-foreground/60 transition-colors duration-150 hover:text-sidebar-foreground" />
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup className="pt-1">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="h-8 rounded-lg border border-sidebar-border text-[13px] text-sidebar-foreground/70 transition-colors duration-150 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
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

      <SidebarFooter className="border-t border-sidebar-border pb-3 pt-2">
        <ResearchUserNav user={user} />
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
      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel>Workspaces</SidebarGroupLabel>
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
                  className="h-8 rounded-none text-[13px] text-sidebar-foreground/50 transition-all duration-150 hover:bg-transparent hover:text-sidebar-foreground data-[active=true]:border-b data-[active=true]:border-dashed data-[active=true]:border-sidebar-foreground/50 data-[active=true]:font-medium data-[active=true]:text-sidebar-foreground"
                  isActive={workspace.id === activeWorkspaceId}
                  onClick={() => onSelectWorkspace(workspace.id)}
                >
                  <ArchiveIcon className="size-4" />
                  <span>{workspace.title}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel>Threads</SidebarGroupLabel>
        <SidebarMenuAction
          disabled={!activeWorkspaceId || isCreatingThread}
          onClick={onCreateThread}
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
        className="h-8 rounded-none text-[13px] text-sidebar-foreground/50 transition-all duration-150 hover:bg-transparent hover:text-sidebar-foreground data-active:bg-transparent data-active:font-normal data-active:text-sidebar-foreground/50 data-[active=true]:border-b data-[active=true]:border-dashed data-[active=true]:border-sidebar-foreground/50 data-[active=true]:font-medium data-[active=true]:text-sidebar-foreground"
        isActive={isActive}
        onClick={onSelect}
      >
        <MessageSquareIcon className="size-4" />
        <span>{thread.title}</span>
      </SidebarMenuButton>
      <DropdownMenu modal={true}>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction
            className="mr-0.5 rounded-md text-sidebar-foreground/50 ring-0 transition-colors duration-150 hover:text-sidebar-foreground focus-visible:ring-0 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            showOnHover={!isActive}
          >
            <MoreHorizontalIcon />
            <span className="sr-only">More</span>
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="bottom">
          <DropdownMenuItem disabled>
            Rename is not wired yet
          </DropdownMenuItem>
          <DropdownMenuItem disabled>
            Archive is not wired yet
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

function ResearchUserNav({ user }: { user: CurrentUser | null }) {
  const { setTheme, resolvedTheme } = useTheme();
  const label = user?.email ?? "Not signed in";

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton className="h-8 rounded-lg bg-transparent px-2 text-sidebar-foreground/70 transition-colors duration-150 hover:text-sidebar-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground">
              <div
                className="size-5 shrink-0 rounded-full ring-1 ring-sidebar-border/50"
                style={{
                  background: user
                    ? `linear-gradient(135deg, oklch(0.35 0.08 ${emailToHue(label)}), oklch(0.25 0.05 ${emailToHue(label) + 40}))`
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
            <DropdownMenuItem disabled className="text-[13px]">
              Authentication is handled by apps/api
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

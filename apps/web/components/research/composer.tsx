"use client";

import {
  ArrowUpIcon,
  MessageSquareIcon,
  PaletteIcon,
  PlusIcon,
  SquareIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import {
  type KeyboardEvent,
  type ReactNode,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import type { AgentRun, LoadState, Thread, Workspace } from "./types";

type SlashCommand = {
  name: string;
  description: string;
  icon: ReactNode;
  disabled?: boolean;
  action: () => void;
};

export function Composer({
  activeThread,
  activeWorkspace,
  isCancellingRun,
  isStartingRun,
  loadState,
  onCancelRun,
  onCreateThread,
  onCreateWorkspace,
  onStartRun,
  run,
}: {
  activeThread: Thread | null;
  activeWorkspace: Workspace | null;
  isCancellingRun: boolean;
  isStartingRun: boolean;
  loadState: LoadState;
  onCancelRun: () => void;
  onCreateWorkspace: () => void;
  onCreateThread: () => void;
  onStartRun: (prompt: string) => Promise<boolean>;
  run: AgentRun | null;
}) {
  const { setTheme, resolvedTheme } = useTheme();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState("");
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [notice, setNotice] = useState("");

  const commands = useMemo<SlashCommand[]>(
    () => [
      {
        name: "workspace",
        description: "Create a new workspace",
        icon: <PlusIcon className="size-3.5" />,
        disabled: loadState === "loading",
        action: onCreateWorkspace,
      },
      {
        name: "thread",
        description: "Create a thread in the selected workspace",
        icon: <MessageSquareIcon className="size-3.5" />,
        disabled: !activeWorkspace || loadState === "loading",
        action: onCreateThread,
      },
      {
        name: "theme",
        description: "Toggle dark/light mode",
        icon: <PaletteIcon className="size-3.5" />,
        action: () => setTheme(resolvedTheme === "dark" ? "light" : "dark"),
      },
    ],
    [
      activeWorkspace,
      loadState,
      onCreateThread,
      onCreateWorkspace,
      resolvedTheme,
      setTheme,
    ]
  );

  const slashQuery = input.startsWith("/") ? input.slice(1).trim() : "";
  const filteredCommands = commands.filter((command) =>
    command.name.startsWith(slashQuery.toLowerCase())
  );
  const canSubmit =
    Boolean(activeThread) &&
    loadState === "ready" &&
    !isStartingRun &&
    !isRunActive(run) &&
    input.trim().length > 0;

  function runCommand(command: SlashCommand) {
    if (command.disabled) {
      return;
    }
    command.action();
    setSlashOpen(false);
    setInput("");
    setNotice("");
    textareaRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (slashOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((index) =>
          Math.min(index + 1, Math.max(filteredCommands.length - 1, 0))
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((index) => Math.max(index - 1, 0));
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const command = filteredCommands[slashIndex];
        if (command) {
          runCommand(command);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashOpen(false);
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  async function submit() {
    if (!canSubmit) {
      setNotice(
        activeThread
          ? isRunActive(run)
            ? "A run is already active for this thread."
            : "Enter a prompt before starting a run."
          : "Select or create a thread before starting a run."
      );
      return;
    }
    const started = await onStartRun(input.trim());
    if (started) {
      setInput("");
      setNotice("");
    } else {
      setNotice("Run creation failed. Check the run status above.");
    }
  }

  return (
    <div className="relative flex w-full flex-col gap-4">
      {!activeThread && loadState !== "loading" && (
        <SuggestedComposerActions
          activeWorkspace={activeWorkspace}
          onCreateThread={onCreateThread}
          onCreateWorkspace={onCreateWorkspace}
        />
      )}

      <div className="relative">
        {slashOpen && filteredCommands.length > 0 && (
          <SlashCommandMenu
            commands={filteredCommands}
            onSelect={runCommand}
            selectedIndex={slashIndex}
          />
        )}
      </div>

      {notice && (
        <div className="px-1 text-[12px] text-muted-foreground">{notice}</div>
      )}

      <form
        className="[&>div]:rounded-2xl [&>div]:border [&>div]:border-border/30 [&>div]:bg-card/70 [&>div]:shadow-[var(--shadow-composer)] [&>div]:transition-shadow [&>div]:duration-300 [&>div]:focus-within:shadow-[var(--shadow-composer-focus)]"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="overflow-hidden">
          <textarea
            className="field-sizing-content max-h-48 min-h-24 w-full resize-none bg-transparent px-4 pb-1.5 pt-3.5 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/35 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={loadState === "loading" || isStartingRun}
            onChange={(event) => {
              const value = event.target.value;
              setInput(value);
              if (value.startsWith("/") && !value.includes(" ")) {
                setSlashOpen(true);
                setSlashIndex(0);
              } else {
                setSlashOpen(false);
              }
              setNotice("");
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              activeThread
                ? "Ask what to research next..."
                : "Select or create a thread..."
            }
            ref={textareaRef}
            value={input}
          />
          <div className="flex items-center justify-between gap-1 px-3 pb-3">
            <div className="flex min-w-0 items-center gap-1">
              <button
                className="h-7 max-w-[200px] justify-between gap-1.5 rounded-lg px-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                disabled
                type="button"
              >
                research-default
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                aria-label="Cancel run"
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-xl p-1 transition-all duration-200 disabled:cursor-not-allowed",
                  isRunActive(run)
                    ? "bg-foreground text-background hover:opacity-85 active:scale-95"
                    : "bg-muted text-muted-foreground/25"
                )}
                disabled={!isRunActive(run) || isCancellingRun}
                onClick={onCancelRun}
                type="button"
              >
                <SquareIcon className="size-4" />
              </button>
              <button
                aria-label="Start run"
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-xl transition-all duration-200",
                  canSubmit
                    ? "bg-foreground text-background hover:opacity-85 active:scale-95"
                    : "cursor-not-allowed bg-muted text-muted-foreground/25"
                )}
                disabled={!canSubmit}
                type="submit"
              >
                <ArrowUpIcon className="size-4" />
              </button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}

function isRunActive(run: AgentRun | null) {
  return Boolean(
    run &&
      (run.status === "created" ||
        run.status === "provisioning_sandbox" ||
        run.status === "running" ||
        run.status === "cancel_requested")
  );
}

function SuggestedComposerActions({
  activeWorkspace,
  onCreateThread,
  onCreateWorkspace,
}: {
  activeWorkspace: Workspace | null;
  onCreateWorkspace: () => void;
  onCreateThread: () => void;
}) {
  const actions = activeWorkspace
    ? [
        {
          label: "Start a research thread in this workspace",
          action: onCreateThread,
        },
      ]
    : [
        {
          label: "Create a workspace for this research path",
          action: onCreateWorkspace,
        },
      ];

  return (
    <div
      className="flex w-full gap-2.5 overflow-x-auto pb-1 sm:grid sm:grid-cols-2 sm:overflow-visible"
      style={{
        scrollbarWidth: "none",
        WebkitOverflowScrolling: "touch",
        msOverflowStyle: "none",
      }}
    >
      {actions.map((action) => (
        <button
          className="h-auto min-w-[220px] shrink-0 whitespace-nowrap rounded-xl border border-border/50 bg-card/30 px-4 py-3 text-left text-[12px] leading-relaxed text-muted-foreground transition-all duration-200 hover:-translate-y-0.5 hover:bg-card/60 hover:text-foreground hover:shadow-[var(--shadow-card)] sm:min-w-0 sm:shrink sm:whitespace-normal sm:p-4 sm:text-[13px]"
          key={action.label}
          onClick={action.action}
          type="button"
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

function SlashCommandMenu({
  commands,
  selectedIndex,
  onSelect,
}: {
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
}) {
  return (
    <div className="absolute bottom-full left-0 right-0 z-50 mb-2 overflow-hidden rounded-xl border border-border/50 bg-card/95 shadow-[var(--shadow-float)] backdrop-blur-xl">
      <div className="px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/40">
        Commands
      </div>
      <div className="max-h-64 overflow-y-auto pb-1 no-scrollbar">
        {commands.map((command, index) => (
          <button
            className={cn(
              "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40",
              index === selectedIndex ? "bg-muted/70" : "hover:bg-muted/40"
            )}
            disabled={command.disabled}
            key={command.name}
            onClick={() => onSelect(command)}
            onMouseDown={(event) => event.preventDefault()}
            type="button"
          >
            <div className="flex size-6 shrink-0 items-center justify-center text-muted-foreground/60">
              {command.icon}
            </div>
            <span className="font-mono text-[13px] text-foreground">
              /{command.name}
            </span>
            <span className="text-[12px] text-muted-foreground/50">
              {command.description}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

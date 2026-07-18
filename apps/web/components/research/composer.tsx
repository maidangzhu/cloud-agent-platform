"use client";

import {
  ArrowUpIcon,
  MessageSquareIcon,
  PaletteIcon,
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
import {
  selectActiveRun,
  selectIsRunActive,
  type ChatState,
} from "@/lib/chat-runtime";
import type { LoadState, Thread, Workspace } from "./types";

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
  chat,
  loadState,
  onCancelRun,
  onCreateThread,
  onStartRun,
}: {
  activeThread: Thread | null;
  activeWorkspace: Workspace | null;
  chat: ChatState;
  loadState: LoadState;
  onCancelRun: () => void;
  onCreateThread: () => void;
  onStartRun: (prompt: string) => Promise<boolean>;
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
      resolvedTheme,
      setTheme,
    ]
  );

  const slashQuery = input.startsWith("/") ? input.slice(1).trim() : "";
  const filteredCommands = commands.filter((command) =>
    command.name.startsWith(slashQuery.toLowerCase())
  );
  const activeRun = selectActiveRun(chat)?.run ?? null;
  const isRunActive = selectIsRunActive(activeRun);
  const isThreadLoading = chat.phase === "loading";
  const canSubmit =
    Boolean(activeThread || activeWorkspace) &&
    loadState === "ready" &&
    !chat.isStarting &&
    !isThreadLoading &&
    !isRunActive &&
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
        activeThread || activeWorkspace
          ? isRunActive
            ? "A run is already active for this thread."
            : "Enter a prompt before starting a run."
          : "The default workspace is unavailable."
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
    <div className="relative flex w-full flex-col gap-2">
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
        <div className="px-1 text-[12px] text-destructive">{notice}</div>
      )}

      <form
        className="[&>div]:rounded-xl [&>div]:border [&>div]:border-input [&>div]:bg-card [&>div]:shadow-[var(--shadow-composer)] [&>div]:transition-colors [&>div]:focus-within:border-ring"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex min-h-[58px] items-end overflow-hidden px-3 py-2">
          <textarea
            className="field-sizing-content max-h-36 min-h-10 min-w-0 flex-1 resize-none bg-transparent px-1 py-2 text-[14px] leading-5 outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={loadState === "loading" || chat.isStarting || isThreadLoading}
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
              activeThread || activeWorkspace
                ? "Ask what to research next..."
                : "Workspace unavailable"
            }
            ref={textareaRef}
            value={input}
          />
          <div className="ml-2 flex shrink-0 items-center gap-1.5 pb-0.5">
            {isRunActive ? (
              <button
                aria-label="Cancel run"
                className={cn(
                  "flex size-8 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed",
                  "bg-foreground text-background hover:opacity-85 active:scale-95"
                )}
                disabled={!isRunActive || chat.isCancelling}
                onClick={onCancelRun}
                type="button"
              >
                <SquareIcon className="size-4" />
              </button>
            ) : (
              <button
                aria-label="Start run"
                className={cn(
                  "flex size-8 items-center justify-center rounded-lg transition-colors",
                  canSubmit
                    ? "bg-foreground text-background hover:opacity-85 active:scale-95"
                    : "cursor-not-allowed bg-muted text-muted-foreground/40"
                )}
                disabled={!canSubmit}
                type="submit"
              >
                <ArrowUpIcon className="size-4" />
              </button>
            )}
          </div>
        </div>
      </form>
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

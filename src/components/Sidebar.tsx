"use client";
import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";

interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
}

interface SessionsResponse {
  code: number;
  message: string;
  data: {
    sessions: SessionSummary[];
  } | null;
}

export function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const [inviteCode, setInviteCode] = useState("");

  const { data: sessions = [] } = useQuery({
    queryKey: ["sidebar-sessions", inviteCode],
    enabled: !!inviteCode && mounted,
    retry: 1,
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/sessions", {
        headers: { "x-invite-code": inviteCode },
        cache: "no-store",
        signal,
      });
      const data = (await res.json()) as SessionsResponse;
      if (data.code !== 0) {
        throw new Error(data.message);
      }
      return (
        data.data?.sessions.map((s) => ({
          id: s.id,
          title: s.title || "New Chat",
          createdAt: s.createdAt,
        })) ?? []
      );
    },
  });

  useEffect(() => {
    setMounted(true);
    const code = localStorage.getItem("inviteCode") ?? "";
    setInviteCode(code);
    if (!code) {
      router.push("/invite");
    }
  }, [router]);

  if (!mounted || !inviteCode) return null;

  return (
    <div className="w-64 border-r border-zinc-800 flex flex-col bg-zinc-950">
      {/* Header */}
      <div className="p-4 border-b border-zinc-800">
        <Button
          onClick={() => router.push("/")}
          variant="ghost"
          className="w-full justify-start text-zinc-300 hover:text-white hover:bg-zinc-800"
        >
          ✨ New Chat
        </Button>
      </div>

      {/* Sessions List */}
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <div className="p-4 text-sm text-zinc-500">No conversations yet</div>
        ) : (
          <div className="space-y-1 p-2">
            {sessions.map((session) => {
              const isActive = pathname === `/chat/${session.id}`;
              return (
                <button
                  key={session.id}
                  onClick={() => router.push(`/chat/${session.id}`)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors truncate ${
                    isActive
                      ? "bg-zinc-800 text-white"
                      : "text-zinc-300 hover:bg-zinc-800/50"
                  }`}
                >
                  {session.title}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-zinc-800">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            localStorage.removeItem("inviteCode");
            router.push("/invite");
          }}
          className="w-full justify-start text-zinc-400 hover:text-zinc-300"
        >
          Logout
        </Button>
      </div>
    </div>
  );
}

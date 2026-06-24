"use client";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Sidebar } from "@/components/Sidebar";

const PROMPT_TEMPLATES = [
  {
    title: "48 小时 Cloud Agent Platform 大作战",
    prompt: `git clone https://github.com/maidangzhu/cloud-agent-platform

克隆这个项目，快速过一遍代码，说说它有哪些技术亮点。`,
  },
  {
    title: "认识麦当 - AI 可读的数字名片",
    prompt: `执行 npx maidang，这是一个给 AI 看的自我介绍名片，看看他最近写的文章、做过什么项目。`,
  },
];


export default function HomePage() {
  const router = useRouter();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  // 检查邀请码
  useEffect(() => {
    if (!localStorage.getItem("inviteCode")) {
      router.push("/invite");
    }
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    console.log("[HomePage] handleSubmit called, input:", input, "loading:", loading);

    if (!input.trim() || loading) {
      console.log("[HomePage] Submit blocked - empty input or loading");
      return;
    }

    const inviteCode = localStorage.getItem("inviteCode");
    if (!inviteCode) {
      console.log("[HomePage] No invite code, redirecting to /invite");
      router.push("/invite");
      return;
    }

    const prompt = input.trim();
    setInput(""); // 立即清空输入框
    setLoading(true);
    console.log("[HomePage] Starting session creation with prompt:", prompt);

    try {
      // 1. 创建 session（使用第一句话作为 title）
      console.log("[HomePage] Step 1: Creating session");
      const sessionRes = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteCode, title: prompt }),
      });
      const sessionData = await sessionRes.json();
      console.log("[HomePage] Session creation response:", sessionData);

      if (sessionData.code !== 0) {
        alert(sessionData.message);
        setLoading(false);
        return;
      }

      const sessionId = sessionData.data.session.id;
      console.log("[HomePage] Session created with ID:", sessionId);

      // 2. 创建 run
      console.log("[HomePage] Step 2: Creating run for session", sessionId);
      const runRes = await fetch(`/api/sessions/${sessionId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const runData = await runRes.json();
      console.log("[HomePage] Run creation response:", runData);

      if (runData.code !== 0) {
        alert(runData.message);
        setLoading(false);
        return;
      }

      // 3. 跳转到对话页面（loading 状态会在跳转后消失）
      console.log("[HomePage] Step 3: Navigating to /chat/" + sessionId);
      router.push(`/chat/${sessionId}`);
    } catch (err) {
      alert("创建对话失败，请重试");
      console.error("[HomePage] Error:", err);
      setLoading(false);
    }
  }

  function fillTemplate(prompt: string) {
    setInput(prompt);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(prompt.length, prompt.length);
    });
  }

  return (
    <div className="flex h-screen bg-zinc-950 text-white">
      {/* 左侧栏 */}
      <Sidebar />

      {/* 主区域：居中输入框 或 loading 状态 */}
      <div className="flex min-h-0 flex-1 flex-col px-4">
        <main className="flex min-h-0 flex-1 items-center justify-center">
          {loading ? (
            // Loading 状态：转圈圈
            <div className="text-center space-y-4">
              <div className="inline-block w-12 h-12 border-4 border-zinc-700 border-t-white rounded-full animate-spin" />
              <p className="text-zinc-400 text-sm">Creating conversation…</p>
            </div>
          ) : (
            // 输入框
            <form onSubmit={handleSubmit} className="w-full max-w-3xl space-y-4">
              <div className="text-center mb-8">
                <h1 className="text-4xl font-bold mb-2">Cloud Agent Platform</h1>
                <p className="text-zinc-400">What can I help you with?</p>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                {PROMPT_TEMPLATES.map((template) => (
                  <button
                    key={template.title}
                    type="button"
                    onClick={() => fillTemplate(template.prompt)}
                    className="min-h-16 rounded-lg border border-zinc-800 bg-zinc-900/70 px-4 py-3 text-left transition-colors hover:border-zinc-600 hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
                  >
                    <span className="block text-sm font-medium text-zinc-100">
                      {template.title}
                    </span>
                  </button>
                ))}
              </div>

              <div className="space-y-3">
                <Label htmlFor="prompt-input" className="sr-only">
                  Your task or question
                </Label>
                <Textarea
                  ref={textareaRef}
                  id="prompt-input"
                  name="prompt"
                  autoComplete="off"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="Type your task or question… (Shift+Enter for new line)"
                  rows={4}
                  className="resize-none"
                  autoFocus
                />
                <Button type="submit" disabled={!input.trim()} className="w-full">
                  Start
                </Button>
              </div>
            </form>
          )}
        </main>

        <footer className="shrink-0 py-6 text-center text-xs text-zinc-500">
          <a
            href="https://maidang.me"
            target="_blank"
            rel="noreferrer"
            className="underline decoration-zinc-700 underline-offset-4 transition-colors hover:text-zinc-300 hover:decoration-zinc-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
          >
            maidang.me
          </a>
        </footer>
      </div>
    </div>
  );
}

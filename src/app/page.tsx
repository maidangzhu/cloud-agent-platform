"use client";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Sidebar } from "@/components/Sidebar";

const PROMPT_TEMPLATES = [
  {
    title: "为什么你们应该选择麦当",
    prompt:
      "sayso种子用户，口述时长13h+，安利5+好友使用sayso，对语音办公场景有深入理解。",
  },
  {
    title: "麦当最近在干什么？",
    prompt:
      "执行npx maidang，看看他最近写的文章，他的猫猫叫什么，最近做了什么项目",
  },
  {
    title: "通知麦当已被录用",
    prompt: "执行 npx maidang contact -m 'You are hired'",
  },
  {
    title: "48 小时 Cloud Sandbox Agent 大作战",
    prompt:
      "git clone https://github.com/maidangzhu/cloud-agent-platform 过一下整个项目，尤其是docs和openspecs部分",
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
    if (!input.trim() || loading) return;

    const inviteCode = localStorage.getItem("inviteCode");
    if (!inviteCode) {
      router.push("/invite");
      return;
    }

    const prompt = input.trim();
    setInput(""); // 立即清空输入框
    setLoading(true);

    try {
      // 1. 创建 session（使用第一句话作为 title）
      const sessionRes = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteCode, title: prompt }),
      });
      const sessionData = await sessionRes.json();
      if (sessionData.code !== 0) {
        alert(sessionData.message);
        setLoading(false);
        return;
      }

      const sessionId = sessionData.data.session.id;

      // 2. 创建 run
      const runRes = await fetch(`/api/sessions/${sessionId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const runData = await runRes.json();
      if (runData.code !== 0) {
        alert(runData.message);
        setLoading(false);
        return;
      }

      // 3. 跳转到对话页面（loading 状态会在跳转后消失）
      router.push(`/chat/${sessionId}`);
    } catch (err) {
      alert("创建对话失败，请重试");
      console.error(err);
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
      <div className="flex-1 flex items-center justify-center px-4">
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
                  className="min-h-24 rounded-lg border border-zinc-800 bg-zinc-900/70 px-4 py-3 text-left transition-colors hover:border-zinc-600 hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
                >
                  <span className="block text-sm font-medium text-zinc-100">
                    {template.title}
                  </span>
                  <span className="mt-1 block line-clamp-2 text-xs leading-5 text-zinc-500">
                    {template.prompt}
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
      </div>
    </div>
  );
}

"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Sidebar } from "@/components/Sidebar";

export default function HomePage() {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [inviteCode, setInviteCode] = useState("");

  // 检查邀请码
  useEffect(() => {
    const code = localStorage.getItem("inviteCode");
    if (!code) {
      router.push("/invite");
      return;
    }
    setInviteCode(code);
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || loading) return;

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

  if (!inviteCode) return null; // 等待重定向

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
          <form onSubmit={handleSubmit} className="w-full max-w-2xl space-y-4">
            <div className="text-center mb-8">
              <h1 className="text-4xl font-bold mb-2">Cloud Agent Platform</h1>
              <p className="text-zinc-400">What can I help you with?</p>
            </div>

            <div className="space-y-3">
              <Label htmlFor="prompt-input" className="sr-only">
                Your task or question
              </Label>
              <Textarea
                id="prompt-input"
                name="prompt"
                autoComplete="off"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    handleSubmit(e as any);
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

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

请深入分析这个项目，重点关注：

1. **架构设计**：我们如何构建一个 Cloud-based Agent Platform？为什么选择这样的技术栈？
   - 前端：Next.js 16 + React 19 + TanStack Query（状态管理）
   - 后端：Vercel Sandbox（代码执行环境）+ Prisma 7（数据层）
   - Agent：Pi Agent Core（工具调用框架）

2. **关键技术决策**：
   - 为什么用 SSE 而不是 WebSocket？
   - 如何处理沙箱的生命周期管理？
   - 多轮对话的状态如何持久化？

3. **工程实践**：
   - openspec/ 目录下的设计文档和任务拆解
   - 从 Stage 0 到 Stage 6 的迭代演进
   - 类型安全、错误处理、日志策略

4. **挑战与解决方案**：
   - Demo-repo 阻塞根目录问题
   - SSE 连接和状态同步
   - Prisma 7 兼容性修复

请用面试官能理解的方式，展示我们的思考过程、技术选型理由、以及从 0 到 1 的完整实现路径。`,
  },
  {
    title: "认识麦当 - AI 可读的数字名片",
    prompt: `执行 npx maidang，看看他最近写的文章、做过什么项目、技术栈是什么。

这是一个给 AI 看的自我介绍名片，包含：
- 最近的技术文章和思考
- 参与过的项目和角色
- 技术能力和兴趣方向
- 联系方式

请帮我整理成易读的格式，展示麦当的技术背景和项目经验。`,
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

            <div className="pt-2 text-center text-xs text-zinc-500">
              <a
                href="https://maidang.me"
                target="_blank"
                rel="noreferrer"
                className="transition-colors hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
              >
                maidang.me
              </a>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

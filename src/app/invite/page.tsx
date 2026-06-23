"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function InvitePage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setLoading(true);
    try {
      const vRes = await fetch("/api/invite", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const v = await vRes.json();
      if (v.code !== 0) { setError(v.message); return; }

      const sRes = await fetch("/api/sessions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ inviteCode: code }),
      });
      const s = await sRes.json();
      if (s.code !== 0) { setError(s.message); return; }

      localStorage.setItem("sessionId", s.data.session.id);
      router.push(`/chat/${s.data.session.id}`);
    } catch {
      setError("网络错误，请重试");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950">
      <form onSubmit={submit} className="flex flex-col gap-4 w-80">
        <h1 className="text-xl font-semibold text-white text-center">Cloud Agent Platform</h1>
        <p className="text-zinc-400 text-sm text-center">请输入邀请码以继续</p>
        <input
          value={code} onChange={e => setCode(e.target.value)}
          placeholder="邀请码"
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-white placeholder:text-zinc-500 outline-none focus:border-zinc-400"
        />
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button
          type="submit" disabled={loading || !code.trim()}
          className="rounded-lg bg-white px-4 py-2.5 text-zinc-900 font-medium disabled:opacity-40 hover:bg-zinc-100 transition-colors"
        >
          {loading ? "验证中…" : "进入"}
        </button>
      </form>
    </div>
  );
}

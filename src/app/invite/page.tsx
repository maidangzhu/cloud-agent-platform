"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function InvitePage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const vRes = await fetch("/api/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const v = await vRes.json();
      if (v.code !== 0) {
        setError(v.message);
        return;
      }

      // 存储邀请码，跳转到主页
      localStorage.setItem("inviteCode", code);
      router.push("/");
    } catch {
      setError("网络错误，请重试");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950">
      <form onSubmit={submit} className="flex flex-col gap-4 w-80">
        <h1 className="text-xl font-semibold text-white text-center">
          Cloud Agent Platform
        </h1>
        <p className="text-zinc-400 text-sm text-center">请输入邀请码以继续</p>

        <div className="space-y-2">
          <Label htmlFor="invite-code">邀请码</Label>
          <Input
            id="invite-code"
            name="inviteCode"
            autoComplete="off"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="输入邀请码…"
            aria-describedby={error ? "invite-error" : undefined}
          />
        </div>

        {error && (
          <p id="invite-error" className="text-red-400 text-sm" role="alert">
            {error}
          </p>
        )}

        <Button type="submit" disabled={loading || !code.trim()}>
          {loading ? "验证中…" : "进入"}
        </Button>
      </form>
    </div>
  );
}

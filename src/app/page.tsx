"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    const sid = localStorage.getItem("sessionId");
    router.replace(sid ? `/chat/${sid}` : "/invite");
  }, [router]);
  return null;
}

"use client";

import { Loader2Icon, LogInIcon, UserPlusIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type AuthMode = "sign-in" | "sign-up";

export type AuthRequest = {
  mode: AuthMode;
  email: string;
  password: string;
  name?: string;
};

export function AuthPanel({
  error,
  onAuthenticate,
}: {
  error: string;
  onAuthenticate: (request: AuthRequest) => Promise<boolean>;
}) {
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit() {
    setLocalError("");
    if (!email.trim() || !password) {
      setLocalError("Email and password are required.");
      return;
    }
    if (mode === "sign-up" && !name.trim()) {
      setLocalError("Name is required.");
      return;
    }

    setIsSubmitting(true);
    const ok = await onAuthenticate({
      mode,
      email: email.trim(),
      password,
      ...(mode === "sign-up" ? { name: name.trim() } : {}),
    });
    setIsSubmitting(false);
    if (!ok) {
      setLocalError("Authentication failed.");
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-[380px] rounded-2xl border border-border/50 bg-card/95 p-5 shadow-[var(--shadow-card)] backdrop-blur-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-medium">
              {mode === "sign-in" ? "Sign in" : "Create account"}
            </div>
            <p className="mt-1 text-[13px] leading-6 text-muted-foreground">
              {mode === "sign-in"
                ? "Use your workspace account to continue."
                : "Create an account and start with a default workspace."}
            </p>
          </div>
          {mode === "sign-in" ? (
            <LogInIcon className="mt-0.5 size-4 text-muted-foreground" />
          ) : (
            <UserPlusIcon className="mt-0.5 size-4 text-muted-foreground" />
          )}
        </div>

        <form
          className="mt-5 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {mode === "sign-up" && (
            <Input
              autoComplete="name"
              onChange={(event) => setName(event.target.value)}
              placeholder="Name"
              value={name}
            />
          )}
          <Input
            autoComplete="email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Email"
            type="email"
            value={email}
          />
          <Input
            autoComplete={
              mode === "sign-in" ? "current-password" : "new-password"
            }
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Password"
            type="password"
            value={password}
          />

          {(localError || error) && (
            <div className="rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-2 text-[12px] leading-5 text-destructive">
              {localError || error}
            </div>
          )}

          <Button className="mt-1" disabled={isSubmitting} type="submit">
            {isSubmitting && <Loader2Icon className="size-4 animate-spin" />}
            {mode === "sign-in" ? "Sign in" : "Create account"}
          </Button>
        </form>

        <button
          className="mt-4 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => {
            setMode((current) =>
              current === "sign-in" ? "sign-up" : "sign-in"
            );
            setLocalError("");
          }}
          type="button"
        >
          {mode === "sign-in"
            ? "Need an account? Create one"
            : "Already have an account? Sign in"}
        </button>
      </div>
    </div>
  );
}

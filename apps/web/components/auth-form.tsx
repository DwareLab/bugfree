"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, ErrorBox, Input, Label } from "./ui";

/** Sign-in and first-run setup share one form; setup creates the first account. */
export function AuthForm({ mode }: { mode: "login" | "setup" }) {
  const router = useRouter();
  const search = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const next = search.get("next");
  const destination = next && next.startsWith("/") && !next.startsWith("//") ? next : "/projects";

  useEffect(() => {
    api<{ setupRequired: boolean; user: unknown }>("/api/auth/state")
      .then((s) => {
        if (s.user) router.replace(destination);
        else if (s.setupRequired && mode === "login") router.replace("/setup");
        else if (!s.setupRequired && mode === "setup") router.replace("/login");
      })
      .catch(() => {});
  }, [destination, mode, router]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(mode === "login" ? "/api/auth/login" : "/api/auth/setup", { method: "POST", json: { email, password } });
      router.replace(mode === "setup" ? "/projects?new=1" : destination);
    } catch (err) {
      setError(err as Error);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h1 className="text-base font-semibold text-ink">{mode === "login" ? "Sign in" : "Create the admin account"}</h1>
        {mode === "setup" && <p className="mt-1 text-sm text-ink-2">First run: this account can then invite the rest of your team.</p>}
      </div>
      {error && <ErrorBox error={error} />}
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="password" hint={mode === "setup" ? "At least 8 characters" : undefined}>
          Password
        </Label>
        <Input
          id="password"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          minLength={mode === "setup" ? 8 : undefined}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <Button type="submit" variant="primary" loading={busy} className="w-full">
        {mode === "login" ? "Sign in" : "Create account"}
      </Button>
    </form>
  );
}

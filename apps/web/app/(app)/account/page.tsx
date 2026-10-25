"use client";

import { KeyRound, UserPlus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { PageHeader, useShell } from "@/components/app-shell";
import { Button, Card, CodeBlock, ErrorBox, Input, Label, Spinner } from "@/components/ui";
import { API_URL, api, useApi } from "@/lib/api";
import { timeAgo } from "@/lib/format";

interface Member {
  id: number;
  email: string;
  created_at: string;
}

interface ApiToken {
  id: number;
  name: string;
  prefix: string;
  read_only: boolean;
  last_used_at: string | null;
  created_at: string;
}

export default function AccountPage() {
  const { user } = useShell();
  const members = useApi<Member[]>("/api/users");

  return (
    <>
      <PageHeader title="Team & account" subtitle="Everyone on the team can see and manage every project." />
      <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-6">
        <Card title="Team members">
          {!members.data ? (
            <Spinner />
          ) : (
            <ul>
              {members.data.map((m) => (
                <li key={m.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-sm last:border-0">
                  <span className="flex size-7 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-ink-2 uppercase">{m.email[0]}</span>
                  <span className="min-w-0 flex-1 truncate text-ink">
                    {m.email} {m.id === user.id && <span className="text-muted">(you)</span>}
                  </span>
                  <span className="hidden text-xs text-muted sm:inline">joined {timeAgo(m.created_at)}</span>
                  {m.id !== user.id && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        if (!confirm(`Remove ${m.email}?`)) return;
                        await api(`/api/users/${m.id}`, { method: "DELETE" });
                        await members.reload();
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <AddMember onAdded={members.reload} />
        </Card>
        <ApiTokens />
        <ChangePassword />
      </div>
    </>
  );
}

function AddMember({ onAdded }: { onAdded: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/users", { method: "POST", json: { email, password } });
      setEmail("");
      setPassword("");
      await onAdded();
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-3 border-t border-line p-4">
      <h3 className="text-sm font-medium text-ink">Add a member</h3>
      {error && <ErrorBox error={error} />}
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div>
          <Label htmlFor="m-email">Email</Label>
          <Input id="m-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="m-pass">Initial password</Label>
          <Input id="m-pass" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <Button type="submit" loading={busy}>
          <UserPlus className="size-4" aria-hidden /> Add
        </Button>
      </div>
      <p className="text-xs text-muted">Share the password with them privately; they can change it here after signing in.</p>
    </form>
  );
}

function ApiTokens() {
  const tokens = useApi<ApiToken[]>("/api/tokens");
  const [name, setName] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const token = await api<ApiToken & { token: string }>("/api/tokens", { method: "POST", json: { name, read_only: readOnly } });
      setCreated(token.token);
      setName("");
      setReadOnly(false);
      await tokens.reload();
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="API tokens & MCP">
      <div className="space-y-3 p-4 text-sm text-ink-2">
        <p>
          Connect Claude Code or another MCP client to <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[12px] text-ink">{API_URL}/mcp</code> so
          it can search issues and logs, read stack traces and resolve issues. A token acts as you and sees every project;
          a read-only token can&apos;t change issue status.
        </p>
        {created ? (
          <div className="space-y-2">
            <p className="font-medium text-ink">Copy this token now: it won&apos;t be shown again.</p>
            <CodeBlock title="token" code={created} />
            <CodeBlock title="Claude Code" code={`claude mcp add --transport http bugfree ${API_URL}/mcp --header "Authorization: Bearer ${created}"`} />
            <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
              Done
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            {error && <ErrorBox error={error} />}
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <div>
                <Label htmlFor="t-name">Token name</Label>
                <Input id="t-name" placeholder="e.g. Claude Code on my laptop" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <Button type="submit" loading={busy}>
                <KeyRound className="size-4" aria-hidden /> Create token
              </Button>
            </div>
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} className="size-4 accent-[var(--accent)]" />
              Read-only: can search and read, but not resolve or ignore issues
            </label>
          </form>
        )}
      </div>
      {tokens.data && tokens.data.length > 0 && (
        <ul className="border-t border-line">
          {tokens.data.map((t) => (
            <li key={t.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-sm last:border-0">
              <span className="min-w-0 flex-1 truncate text-ink">
                {t.name} <span className="font-mono text-xs text-muted">{t.prefix}…</span>
                {t.read_only && <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted">read-only</span>}
              </span>
              <span className="hidden text-xs text-muted sm:inline">{t.last_used_at ? `used ${timeAgo(t.last_used_at)}` : "never used"}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  if (!confirm(`Revoke "${t.name}"? Clients using it stop working immediately.`)) return;
                  await api(`/api/tokens/${t.id}`, { method: "DELETE" });
                  await tokens.reload();
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [done, setDone] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await api("/api/auth/password", { method: "POST", json: { currentPassword: current, newPassword: next } });
      setCurrent("");
      setNext("");
      setDone(true);
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Change password">
      <form onSubmit={submit} className="space-y-3 p-4">
        {error && <ErrorBox error={error} />}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="cur">Current password</Label>
            <Input id="cur" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="new">New password</Label>
            <Input id="new" type="password" autoComplete="new-password" minLength={8} required value={next} onChange={(e) => setNext(e.target.value)} />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" loading={busy}>
            Update password
          </Button>
          {done && <span className="text-sm text-good-ink">Password updated.</span>}
        </div>
      </form>
    </Card>
  );
}

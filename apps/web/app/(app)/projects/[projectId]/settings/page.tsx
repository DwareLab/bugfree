"use client";

import { ExternalLink, Eye, EyeOff, PartyPopper, RefreshCw, Send, TriangleAlert } from "lucide-react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useEffect, useState } from "react";
import { PageHeader, useShell } from "@/components/app-shell";
import { DockerLogsSetup } from "@/components/docker-logs-setup";
import { SetupGuide } from "@/components/setup-guide";
import { Button, Card, CodeBlock, CopyButton, ErrorBox, Input, Label, Spinner } from "@/components/ui";
import { type Project, api, useApi } from "@/lib/api";

export default function SettingsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Settings />
    </Suspense>
  );
}

function Settings() {
  const { projectId } = useParams<{ projectId: string }>();
  const created = useSearchParams().get("created") === "1";
  const project = useApi<Project>(`/api/projects/${projectId}`);

  if (project.error) return <div className="p-6"><ErrorBox error={project.error} onRetry={project.reload} /></div>;
  if (!project.data) return <Spinner />;
  const p = project.data;

  return (
    <>
      <PageHeader title={`${p.name} · Settings & setup`} subtitle="Connect your app, manage keys and alerts." />
      <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-6">
        {created && (
          <div className="flex items-start gap-3 rounded-lg border border-line bg-accent-wash px-4 py-3 text-sm text-ink">
            <PartyPopper className="mt-0.5 size-4 shrink-0 text-accent-ink" aria-hidden />
            <div>
              <strong>Project created.</strong> Follow the steps below; your first error will show up on the issues page within seconds.
            </div>
          </div>
        )}

        <Card title="Client key (DSN)">
          <div className="space-y-2 p-4">
            <p className="text-sm text-ink-2">Tells the SDK where to send events. It&apos;s safe to ship in browser code: it can only submit events.</p>
            <div className="flex items-center gap-2 rounded-md border border-line bg-code px-3 py-2">
              <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{p.dsn}</code>
              <CopyButton text={p.dsn} />
            </div>
          </div>
        </Card>

        <Card title="Set up the SDK">
          <div className="p-4">
            <SetupGuide project={p} />
          </div>
        </Card>

        <Card title="Collect Docker logs">
          <div className="p-4">
            <DockerLogsSetup project={p} />
          </div>
        </Card>

        <BugReportPortal project={p} onChange={project.setData} />
        <SecretKey project={p} onChange={project.setData} />
        <Alerts project={p} onChange={project.setData} />
        <General project={p} onChange={project.setData} />
      </div>
    </>
  );
}

function BugReportPortal({ project, onChange }: { project: Project; onChange: (p: Project) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  async function toggle(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      onChange(await api<Project>(`/api/projects/${project.id}`, { method: "PATCH", json: { portal_enabled: enabled } }));
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  }

  const url = project.portal_url;
  return (
    <div id="portal" className="scroll-mt-4">
      <Card title="Bug report page">
        <div className="space-y-4 p-4">
          <p className="text-sm text-ink-2">
            A public page where your users sign in with GitHub and report bugs. Each reporter sees only their own reports and your replies. Reports
            land on the <strong className="font-medium text-ink">Bug reports</strong> board, and new ones are sent to the alert webhook and emails below.
          </p>
          {error && <ErrorBox error={error} />}
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={project.portal_enabled}
              disabled={busy}
              onChange={(e) => toggle(e.target.checked)}
              className="size-4 accent-[var(--accent)]"
            />
            Accept bug reports from users
          </label>
          {project.portal_enabled && url && (
            <>
              <div className="flex items-center gap-2 rounded-md border border-line bg-code px-3 py-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{url}</code>
                <CopyButton text={url} />
                <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted hover:bg-surface-hover hover:text-ink">
                  <ExternalLink className="size-3.5" aria-hidden />
                  Open
                </a>
              </div>
              <div className="space-y-1.5">
                <p className="text-sm text-ink-2">
                  Link to it from your app&apos;s help menu. Pass the current page as <code className="font-mono text-[12.5px]">url</code> and the form
                  fills it in:
                </p>
                <CodeBlock title="tsx" code={`<a href={\`${url}?url=\${encodeURIComponent(location.href)}\`} target="_blank">Report a bug</a>`} />
              </div>
            </>
          )}
          {!project.portal_github_configured && (
            <div className="flex items-start gap-2.5 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-sm text-ink">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <div className="space-y-1">
                <p>
                  <strong className="font-medium">GitHub sign-in isn&apos;t set up on this server yet.</strong> Create a{" "}
                  <a href="https://github.com/settings/applications/new" target="_blank" rel="noreferrer" className="text-accent-ink hover:underline">
                    GitHub OAuth app
                  </a>{" "}
                  with this authorization callback URL, then set <code className="font-mono text-[12.5px]">GITHUB_CLIENT_ID</code> and{" "}
                  <code className="font-mono text-[12.5px]">GITHUB_CLIENT_SECRET</code> on the API.
                </p>
                <div className="flex items-center gap-2 rounded-md border border-line bg-code px-3 py-1.5">
                  <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{`${project.api_url}/api/portal/auth/github/callback`}</code>
                  <CopyButton text={`${project.api_url}/api/portal/auth/github/callback`} />
                </div>
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

function SecretKey({ project, onChange }: { project: Project; onChange: (p: Project) => void }) {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  async function rotate(key: "public" | "secret") {
    const warning =
      key === "public"
        ? "Rotate the DSN key? Apps using the current DSN will stop reporting until you deploy the new one."
        : "Rotate the secret key? CI jobs using the current key will fail to upload source maps.";
    if (!confirm(warning)) return;
    setBusy(key);
    try {
      onChange(await api<Project>(`/api/projects/${project.id}/rotate-keys`, { method: "POST", json: { key } }));
    } finally {
      setBusy(null);
    }
  }
  return (
    <Card title="Secret key (CLI)">
      <div className="space-y-3 p-4">
        <p className="text-sm text-ink-2">
          Used by <code className="font-mono text-[12px]">bugfree sourcemaps upload</code> as <code className="font-mono text-[12px]">BUGFREE_AUTH_TOKEN</code>. Keep it in CI secrets, never in client code.
        </p>
        <div className="flex items-center gap-2 rounded-md border border-line bg-code px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{show ? project.secret_key : "•".repeat(32)}</code>
          <button onClick={() => setShow((s) => !s)} className="rounded p-1 text-muted hover:text-ink" aria-label={show ? "Hide secret key" : "Show secret key"}>
            {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
          <CopyButton text={project.secret_key} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => rotate("secret")} loading={busy === "secret"}>
            <RefreshCw className="size-3.5" aria-hidden /> Rotate secret key
          </Button>
          <Button size="sm" variant="ghost" onClick={() => rotate("public")} loading={busy === "public"}>
            Rotate DSN key
          </Button>
        </div>
      </div>
    </Card>
  );
}

function Alerts({ project, onChange }: { project: Project; onChange: (p: Project) => void }) {
  const [webhook, setWebhook] = useState(project.alert_webhook_url ?? "");
  const [emails, setEmails] = useState(project.alert_emails ?? "");
  const [onNew, setOnNew] = useState(project.alert_on_new);
  const [onRegression, setOnRegression] = useState(project.alert_on_regression);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      onChange(
        await api<Project>(`/api/projects/${project.id}`, {
          method: "PATCH",
          json: { alert_webhook_url: webhook.trim() || null, alert_emails: emails.trim() || null, alert_on_new: onNew, alert_on_regression: onRegression },
        }),
      );
      setMessage("Saved.");
    } catch (err) {
      setError(err as Error);
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setMessage(null);
    setError(null);
    try {
      const r = await api<{ webhook?: string; email?: string }>(`/api/projects/${project.id}/test-alert`, { method: "POST" });
      const parts = [r.webhook && `Webhook: ${r.webhook}`, r.email && `Email: ${r.email}`].filter(Boolean);
      setMessage(parts.length ? parts.join(" · ") : "Nothing to test: save a webhook URL or email first.");
    } catch (err) {
      setError(err as Error);
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card title="Alerts">
      <form onSubmit={save} className="space-y-4 p-4">
        <p className="text-sm text-ink-2">Get notified when a new issue appears or a resolved one comes back. At most one alert per issue every 30 minutes.</p>
        {error && <ErrorBox error={error} />}
        <div>
          <Label htmlFor="webhook" hint="Slack or Discord incoming webhook, or any URL that accepts a JSON POST.">
            Webhook URL
          </Label>
          <Input id="webhook" type="url" placeholder="https://hooks.slack.com/services/…" value={webhook} onChange={(e) => setWebhook(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="emails" hint="Comma-separated. Requires SMTP_URL on the API server.">
            Email recipients
          </Label>
          <Input id="emails" placeholder="oncall@example.com, dev@example.com" value={emails} onChange={(e) => setEmails(e.target.value)} />
        </div>
        <div className="space-y-2 text-sm text-ink">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={onNew} onChange={(e) => setOnNew(e.target.checked)} className="size-4 accent-[var(--accent)]" />
            New issues
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={onRegression} onChange={(e) => setOnRegression(e.target.checked)} className="size-4 accent-[var(--accent)]" />
            Regressions (a resolved issue happens again in a release that hadn't had it)
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" loading={saving}>
            Save alerts
          </Button>
          <Button type="button" onClick={test} loading={testing}>
            <Send className="size-3.5" aria-hidden /> Send test alert
          </Button>
          {message && <span className="text-sm text-ink-2">{message}</span>}
        </div>
      </form>
    </Card>
  );
}

function General({ project, onChange }: { project: Project; onChange: (p: Project) => void }) {
  const { reloadProjects } = useShell();
  const router = useRouter();
  const [name, setName] = useState(project.name);
  const [saving, setSaving] = useState(false);
  useEffect(() => setName(project.name), [project.name]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      onChange(await api<Project>(`/api/projects/${project.id}`, { method: "PATCH", json: { name } }));
      await reloadProjects();
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const typed = prompt(`This permanently deletes "${project.name}", its issues, events and source maps.\n\nType the project name to confirm:`);
    if (typed !== project.name) return;
    await api(`/api/projects/${project.id}`, { method: "DELETE" });
    await reloadProjects();
    router.replace("/projects");
  }

  return (
    <Card title="General">
      <form onSubmit={save} className="flex flex-wrap items-end gap-2 p-4">
        <div className="min-w-56 flex-1">
          <Label htmlFor="pname">Project name</Label>
          <Input id="pname" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <Button type="submit" loading={saving} disabled={name === project.name}>
          Rename
        </Button>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line p-4">
        <div>
          <h3 className="text-sm font-medium text-ink">Delete project</h3>
          <p className="text-sm text-ink-2">Removes all issues, events and uploaded source maps.</p>
        </div>
        <Button variant="danger" onClick={remove}>
          Delete project
        </Button>
      </div>
    </Card>
  );
}

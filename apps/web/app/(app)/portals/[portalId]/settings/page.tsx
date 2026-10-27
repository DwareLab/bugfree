"use client";

import { ArrowDown, ArrowUp, ExternalLink, PartyPopper, Plus, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useState } from "react";
import { PageHeader, useShell } from "@/components/app-shell";
import { Select, Textarea } from "@/components/tickets";
import { Button, Card, CodeBlock, CopyButton, ErrorBox, Input, Label, Spinner } from "@/components/ui";
import { type PortalSummary, api, useApi } from "@/lib/api";
import { cx } from "@/lib/format";

export default function PortalSettingsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <PortalSettings />
    </Suspense>
  );
}

function PortalSettings() {
  const { portalId } = useParams<{ portalId: string }>();
  const created = useSearchParams().get("created") === "1";
  const portal = useApi<PortalSummary>(`/api/portals/${portalId}`);
  const { reloadPortals } = useShell();

  if (portal.error) return <div className="p-6"><ErrorBox error={portal.error} onRetry={portal.reload} /></div>;
  if (!portal.data) return <Spinner />;
  const po = portal.data;
  const changed = (p: PortalSummary) => {
    portal.setData(p);
    void reloadPortals();
  };

  return (
    <>
      <PageHeader
        title={`${po.name} · Settings`}
        subtitle={
          <Link href={`/portals/${po.id}`} className="text-accent-ink hover:underline">
            ← Back to the board
          </Link>
        }
      />
      <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-6">
        {created && (
          <div className="flex items-start gap-3 rounded-lg border border-line bg-accent-wash px-4 py-3 text-sm text-ink">
            <PartyPopper className="mt-0.5 size-4 shrink-0 text-accent-ink" aria-hidden />
            <div>
              <strong>Report page created.</strong> Share the link below with your users. Reports show up on this page&apos;s board.
            </div>
          </div>
        )}
        {!po.github_configured && <GitHubSetup portal={po} />}
        <Share key={`share-${po.slug}-${po.enabled}`} portal={po} onChange={changed} />
        <Details key={`details-${po.id}-${JSON.stringify(po.projects)}`} portal={po} onChange={changed} />
        <Notifications portal={po} onChange={changed} />
        <Danger portal={po} />
      </div>
    </>
  );
}

function useSave(portal: PortalSummary, onChange: (p: PortalSummary) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);
  async function save(patch: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      onChange(await api<PortalSummary>(`/api/portals/${portal.id}`, { method: "PATCH", json: patch }));
      setSaved(true);
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, saved, save };
}

function Share({ portal, onChange }: { portal: PortalSummary; onChange: (p: PortalSummary) => void }) {
  const { busy, error, saved, save } = useSave(portal, onChange);
  const [slug, setSlug] = useState(portal.slug);
  const prefix = portal.url.slice(0, portal.url.length - encodeURIComponent(portal.slug).length);

  return (
    <Card title="Share">
      <div className="space-y-4 p-4">
        {error && <ErrorBox error={error} />}
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={portal.enabled} disabled={busy} onChange={(e) => save({ enabled: e.target.checked })} className="size-4 accent-[var(--accent)]" />
          Accept bug reports on this page
          <span className="text-muted">{portal.enabled ? "" : "(off: the link shows “not found”)"}</span>
        </label>
        <div className="flex items-center gap-2 rounded-md border border-line bg-code px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{portal.url}</code>
          <CopyButton text={portal.url} />
          <a href={portal.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted hover:bg-surface-hover hover:text-ink">
            <ExternalLink className="size-3.5" aria-hidden />
            Open
          </a>
        </div>
        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ slug });
          }}
        >
          <Label htmlFor="slug" hint="Changing it breaks links you've already shared.">
            Address
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center rounded-md border border-line bg-surface focus-within:border-accent">
              <span className="shrink-0 truncate pl-3 text-sm text-muted">{prefix.replace(/^https?:\/\//, "")}</span>
              <input
                id="slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                pattern="[a-z0-9][a-z0-9\-]{1,58}[a-z0-9]"
                title="3–60 lowercase letters, digits and dashes"
                required
                className="h-9 min-w-24 flex-1 bg-transparent pr-3 text-sm text-ink focus:outline-none"
              />
            </div>
            <Button type="submit" loading={busy} disabled={slug === portal.slug}>
              Change address
            </Button>
          </div>
          {saved && slug === portal.slug && <p className="text-sm text-ink-2">Saved.</p>}
        </form>
        <div className="space-y-1.5">
          <p className="text-sm text-ink-2">
            Link to it from your app&apos;s help menu. Pass the current page as <code className="font-mono text-[12.5px]">url</code> and the form fills it in:
          </p>
          <CodeBlock title="tsx" code={`<a href={\`${portal.url}?url=\${encodeURIComponent(location.href)}\`} target="_blank">Report a bug</a>`} />
        </div>
      </div>
    </Card>
  );
}

interface Row {
  project_id: number;
  label: string;
}

/** Name, welcome text, which projects the page covers (and what reporters call them), and how reports are routed. */
function Details({ portal, onChange }: { portal: PortalSummary; onChange: (p: PortalSummary) => void }) {
  const { projects } = useShell();
  const { busy, error, saved, save } = useSave(portal, onChange);
  const [name, setName] = useState(portal.name);
  const [intro, setIntro] = useState(portal.intro ?? "");
  const [askProject, setAskProject] = useState(portal.ask_project);
  const [rows, setRows] = useState<Row[]>(portal.projects.map((p) => ({ project_id: p.id, label: p.label ?? "" })));
  const nameOf = (id: number) => projects.find((p) => p.id === id)?.name ?? portal.projects.find((p) => p.id === id)?.name ?? `Project ${id}`;
  const available = projects.filter((p) => !rows.some((r) => r.project_id === p.id));

  const move = (i: number, by: number) =>
    setRows((prev) => {
      const next = [...prev];
      [next[i], next[i + by]] = [next[i + by], next[i]];
      return next;
    });

  function submit(e: FormEvent) {
    e.preventDefault();
    void save({ name, intro: intro.trim() || null, ask_project: askProject, projects: rows.map((r) => ({ project_id: r.project_id, label: r.label.trim() || null })) });
  }

  return (
    <Card title="Page and routing">
      <form onSubmit={submit} className="space-y-5 p-4">
        {error && <ErrorBox error={error} />}
        <div>
          <Label htmlFor="name" hint="The page title your users see.">
            Name
          </Label>
          <Input id="name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="intro" hint="Optional: shown above the form. Say what to include, or when you usually reply.">
            Welcome text
          </Label>
          <Textarea id="intro" rows={3} maxLength={2000} value={intro} onChange={(e) => setIntro(e.target.value)} />
        </div>

        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-sm font-medium text-ink">
            Projects
            <span className="mt-0.5 block text-xs font-normal text-muted">
              Reports are routed to one of these. Reporters see the label instead of the project&apos;s name when you set one.
            </span>
          </legend>
          {rows.map((r, i) => (
            <div key={r.project_id} className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2">
              <span className="min-w-32 flex-1 truncate text-sm font-medium text-ink">{nameOf(r.project_id)}</span>
              <div className="w-56 max-w-full">
                <Input
                  aria-label={`Label for ${nameOf(r.project_id)}`}
                  placeholder={`Shown as “${nameOf(r.project_id)}”`}
                  maxLength={100}
                  value={r.label}
                  onChange={(e) => setRows((prev) => prev.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                  className="h-8"
                />
              </div>
              <div className="flex items-center">
                <Button type="button" variant="ghost" size="sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                  <ArrowUp className="size-3.5" aria-hidden />
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                  <ArrowDown className="size-3.5" aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={rows.length === 1}
                  onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                  aria-label={`Remove ${nameOf(r.project_id)}`}
                >
                  <X className="size-3.5" aria-hidden />
                </Button>
              </div>
            </div>
          ))}
          {available.length > 0 && (
            <div className="flex items-center gap-2">
              <Plus className="size-4 text-muted" aria-hidden />
              <Select
                label="Add a project"
                value=""
                options={[{ value: "", label: "Add a project…" }, ...available.map((p) => ({ value: String(p.id), label: p.name }))]}
                onChange={(id) => id && setRows((prev) => [...prev, { project_id: Number(id), label: "" }])}
              />
            </div>
          )}
        </fieldset>

        {rows.length > 1 ? (
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium text-ink">Routing</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {[
                { value: true, title: "Reporters pick the project", hint: "The form asks which one it's about. “Not sure” goes to the inbox." },
                { value: false, title: "Your team routes every report", hint: "Reports wait in this page's inbox until you pick a project." },
              ].map((o) => (
                <label
                  key={String(o.value)}
                  className={cx(
                    "flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm",
                    askProject === o.value ? "border-accent bg-accent-wash" : "border-line bg-surface hover:bg-surface-hover",
                  )}
                >
                  <input type="radio" name="routing" checked={askProject === o.value} onChange={() => setAskProject(o.value)} className="mt-0.5 accent-[var(--accent)]" />
                  <span>
                    <span className="block font-medium text-ink">{o.title}</span>
                    <span className="block text-xs text-ink-2">{o.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <p className="text-sm text-ink-2">With one project, every report goes straight to it.</p>
        )}

        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" loading={busy}>
            Save
          </Button>
          {saved && <span className="text-sm text-ink-2">Saved.</span>}
        </div>
      </form>
    </Card>
  );
}

function Notifications({ portal, onChange }: { portal: PortalSummary; onChange: (p: PortalSummary) => void }) {
  const { busy, error, saved, save } = useSave(portal, onChange);
  const [webhook, setWebhook] = useState(portal.alert_webhook_url ?? "");
  const [emails, setEmails] = useState(portal.alert_emails ?? "");

  return (
    <Card title="Notifications">
      <form
        className="space-y-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save({ alert_webhook_url: webhook.trim() || null, alert_emails: emails.trim() || null });
        }}
      >
        <p className="text-sm text-ink-2">
          Where to announce every new report from this page. Leave both empty to use the alert settings of the project a report is routed to.
        </p>
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
          <Input id="emails" placeholder="support@example.com" value={emails} onChange={(e) => setEmails(e.target.value)} />
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" loading={busy}>
            Save notifications
          </Button>
          {saved && <span className="text-sm text-ink-2">Saved.</span>}
        </div>
      </form>
    </Card>
  );
}

function GitHubSetup({ portal }: { portal: PortalSummary }) {
  const callback = `${portal.api_url}/api/portal/auth/github/callback`;
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm text-ink">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 space-y-1.5">
        <p>
          <strong className="font-medium">GitHub sign-in isn&apos;t set up on this server yet</strong>, so people can&apos;t sign in to report. Create a{" "}
          <a href="https://github.com/settings/applications/new" target="_blank" rel="noreferrer" className="text-accent-ink hover:underline">
            GitHub OAuth app
          </a>{" "}
          with this authorization callback URL, then set <code className="font-mono text-[12.5px]">GITHUB_CLIENT_ID</code> and{" "}
          <code className="font-mono text-[12.5px]">GITHUB_CLIENT_SECRET</code> on the API.
        </p>
        <div className="flex items-center gap-2 rounded-md border border-line bg-code px-3 py-1.5">
          <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{callback}</code>
          <CopyButton text={callback} />
        </div>
      </div>
    </div>
  );
}

function Danger({ portal }: { portal: PortalSummary }) {
  const { reloadPortals } = useShell();
  const router = useRouter();
  const [error, setError] = useState<Error | null>(null);
  async function remove() {
    const inbox = portal.unrouted_tickets ? ` Its ${portal.unrouted_tickets} unrouted reports will be deleted.` : "";
    if (!confirm(`Delete the report page “${portal.name}”? Its link stops working. Reports routed to a project stay on that project's board.${inbox}`)) return;
    try {
      await api(`/api/portals/${portal.id}`, { method: "DELETE" });
      await reloadPortals();
      router.replace("/portals");
    } catch (err) {
      setError(err as Error);
    }
  }
  return (
    <Card title="Delete">
      <div className="space-y-3 p-4">
        {error && <ErrorBox error={error} />}
        <p className="text-sm text-ink-2">Reports already routed to a project stay on that project&apos;s board. To pause the page instead, turn it off above.</p>
        <Button variant="danger" onClick={remove}>
          Delete report page
        </Button>
      </div>
    </Card>
  );
}

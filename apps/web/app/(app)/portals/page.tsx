"use client";

import { Globe, Plus, Split } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useState } from "react";
import { PageHeader, useShell } from "@/components/app-shell";
import { Button, Card, CopyButton, EmptyState, ErrorBox, Input, Label, Spinner } from "@/components/ui";
import { type PortalSummary, api } from "@/lib/api";
import { cx } from "@/lib/format";

export default function PortalsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Portals />
    </Suspense>
  );
}

function Portals() {
  const { portals } = useShell();
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const creating = search.get("new") === "1";

  return (
    <>
      <PageHeader
        title="Report pages"
        subtitle="Public pages where your users sign in with GitHub and report bugs. A page can cover one project or several."
        actions={
          !creating && (
            <Button variant="primary" onClick={() => router.push(`${pathname}?new=1`)}>
              <Plus className="size-4" aria-hidden />
              New report page
            </Button>
          )
        }
      />
      <div className="mx-auto max-w-4xl space-y-4 p-4 md:p-6">
        {creating && <NewPortal preselect={Number(search.get("project")) || null} onCancel={() => router.push(pathname)} />}
        {portals.map((po) => (
          <Card key={po.id}>
            <div className="flex flex-wrap items-start gap-3 p-4">
              <Globe className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/portals/${po.id}`} className="font-semibold text-ink hover:underline">
                    {po.name}
                  </Link>
                  {!po.enabled && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">Off</span>}
                </div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1 text-sm">
                  <a href={po.url} target="_blank" rel="noreferrer" className="truncate text-accent-ink hover:underline">
                    {po.url.replace(/^https?:\/\//, "")}
                  </a>
                  <CopyButton text={po.url} label="Copy link" />
                </div>
                <p className="mt-1 text-sm text-ink-2">
                  {po.projects.length === 1 ? "Project: " : `${po.projects.length} projects: `}
                  {po.projects.map((p) => p.name).join(", ")}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1 text-sm">
                <Link href={`/portals/${po.id}`}>
                  <Button size="sm">Open board</Button>
                </Link>
                <span className="text-xs text-muted">
                  {po.new_tickets} new
                  {po.unrouted_tickets > 0 && (
                    <span className="text-ink">
                      {" · "}
                      <Split className="inline size-3 text-serious" aria-hidden /> {po.unrouted_tickets} to route
                    </span>
                  )}
                </span>
              </div>
            </div>
          </Card>
        ))}
        {!portals.length && !creating && (
          <EmptyState icon={<Globe className="size-8" />} title="No report pages yet">
            Create one for a project, or one page for a whole product that spans several projects. Share its link, and reports land on a board where
            you route them to the right project.
          </EmptyState>
        )}
      </div>
    </>
  );
}

function NewPortal({ preselect, onCancel }: { preselect: number | null; onCancel: () => void }) {
  const { projects, reloadPortals } = useShell();
  const router = useRouter();
  const [name, setName] = useState(() => projects.find((p) => p.id === preselect)?.name ?? "");
  const [selected, setSelected] = useState<Set<number>>(() => new Set(preselect ? [preselect] : projects.length === 1 ? [projects[0].id] : []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const portal = await api<PortalSummary>("/api/portals", { method: "POST", json: { name, project_ids: [...selected] } });
      await reloadPortals();
      router.push(`/portals/${portal.id}/settings?created=1`);
    } catch (err) {
      setError(err as Error);
      setBusy(false);
    }
  }

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Card title="New report page">
      <form onSubmit={submit} className="space-y-4 p-4">
        {error && <ErrorBox error={error} />}
        <div>
          <Label htmlFor="portal-name" hint="Your users see this as the page title, e.g. your product's name.">
            Name
          </Label>
          <Input id="portal-name" autoFocus required maxLength={100} placeholder="Acme Shop" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-ink">
            Projects
            <span className="mt-0.5 block text-xs font-normal text-muted">
              Reports from this page are routed to one of these. Pick several for a product made of more than one app.
            </span>
          </legend>
          {projects.length ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {projects.map((p) => (
                <label
                  key={p.id}
                  className={cx(
                    "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm",
                    selected.has(p.id) ? "border-accent bg-accent-wash" : "border-line bg-surface hover:bg-surface-hover",
                  )}
                >
                  <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} className="size-4 accent-[var(--accent)]" />
                  <span className="truncate text-ink">{p.name}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="text-sm text-ink-2">
              Create a <Link href="/projects?new=1" className="text-accent-ink hover:underline">project</Link> first.
            </p>
          )}
        </fieldset>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={busy} disabled={!selected.size}>
            Create report page
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

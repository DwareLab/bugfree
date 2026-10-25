"use client";

import { FolderKanban, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useState } from "react";
import { PageHeader, useShell } from "@/components/app-shell";
import { Button, Card, EmptyState, ErrorBox, Input, Label, Segmented } from "@/components/ui";
import { type Project, api } from "@/lib/api";
import { compact, timeAgo } from "@/lib/format";

export default function ProjectsPage() {
  return (
    <Suspense>
      <Projects />
    </Suspense>
  );
}

function Projects() {
  const { projects } = useShell();
  const search = useSearchParams();
  const router = useRouter();
  const creating = search.get("new") === "1";

  return (
    <>
      <PageHeader
        title="Projects"
        subtitle="One project per app you want to monitor."
        actions={
          !creating && (
            <Button variant="primary" onClick={() => router.push("/projects?new=1")}>
              <Plus className="size-4" aria-hidden /> New project
            </Button>
          )
        }
      />
      <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
        {creating && <NewProject onCancel={() => router.push("/projects")} />}
        {projects.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <Link key={p.id} href={`/projects/${p.id}`} className="group rounded-lg border border-line bg-surface p-4 transition-colors hover:border-accent">
                <div className="flex items-center gap-2">
                  <FolderKanban className="size-4 text-muted group-hover:text-accent" aria-hidden />
                  <h2 className="truncate font-medium text-ink">{p.name}</h2>
                  <span className="ml-auto rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2">{p.platform}</span>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <dt className="text-xs text-muted">Unresolved</dt>
                    <dd className="text-lg font-semibold text-ink">{compact(p.unresolved_issues)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Events, 24h</dt>
                    <dd className="text-lg font-semibold text-ink">{compact(p.events_24h)}</dd>
                  </div>
                </dl>
                <p className="mt-2 text-xs text-muted">Last event {timeAgo(p.last_event_at)}</p>
              </Link>
            ))}
          </div>
        ) : (
          !creating && (
            <Card>
              <EmptyState icon={<FolderKanban className="size-8" />} title="No projects yet">
                Create a project to get a DSN, then add the SDK to your Next.js or Express app.
              </EmptyState>
            </Card>
          )
        )}
      </div>
    </>
  );
}

function NewProject({ onCancel }: { onCancel: () => void }) {
  const { reloadProjects } = useShell();
  const router = useRouter();
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState<"nextjs" | "express">("nextjs");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const project = await api<Project>("/api/projects", { method: "POST", json: { name, platform } });
      await reloadProjects();
      router.push(`/projects/${project.id}/settings?created=1`);
    } catch (err) {
      setError(err as Error);
      setBusy(false);
    }
  }

  return (
    <Card title="New project">
      <form onSubmit={submit} className="space-y-4 p-4">
        {error && <ErrorBox error={error} />}
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <div>
            <Label htmlFor="name">Name</Label>
            <Input id="name" autoFocus required maxLength={100} placeholder="storefront-web" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label>Platform</Label>
            <Segmented
              value={platform}
              onChange={setPlatform}
              options={[
                { value: "nextjs", label: "Next.js" },
                { value: "express", label: "Express" },
              ]}
            />
          </div>
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={busy}>
            Create project
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

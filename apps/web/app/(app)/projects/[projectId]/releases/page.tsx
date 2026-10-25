"use client";

import { ChevronDown, ChevronRight, FileCode2, Package } from "lucide-react";
import { useParams } from "next/navigation";
import { useState } from "react";
import { PageHeader, useShell } from "@/components/app-shell";
import { Button, Card, EmptyState, ErrorBox, Spinner } from "@/components/ui";
import { type Artifact, type Release, api, useApi } from "@/lib/api";
import { bytes, compact, timeAgo } from "@/lib/format";

export default function ReleasesPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { projects } = useShell();
  const project = projects.find((p) => p.id === Number(projectId));
  const releases = useApi<Release[]>(`/api/projects/${projectId}/releases`);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <>
      <PageHeader title={`${project?.name ?? "Project"} · Releases`} subtitle="Versions seen in events, and the source maps uploaded for them." />
      <div className="mx-auto max-w-5xl p-4 md:p-6">
        {releases.error && <ErrorBox error={releases.error} onRetry={releases.reload} />}
        {!releases.data ? (
          <Spinner />
        ) : releases.data.length === 0 ? (
          <Card>
            <EmptyState icon={<Package className="size-8" />} title="No releases yet">
              Set <code className="font-mono text-[12px]">release</code> in the SDK (or <code className="font-mono text-[12px]">BUGFREE_RELEASE</code>) and upload source maps with the CLI to see them here.
            </EmptyState>
          </Card>
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th className="px-4 py-2 font-medium">Release</th>
                    <th className="px-4 py-2 font-medium">Created</th>
                    <th className="px-4 py-2 text-right font-medium">New issues</th>
                    <th className="px-4 py-2 text-right font-medium">Events</th>
                    <th className="px-4 py-2 text-right font-medium">Source maps</th>
                  </tr>
                </thead>
                <tbody>
                  {releases.data.map((r) => (
                    <ReleaseRow
                      key={r.version}
                      projectId={projectId}
                      release={r}
                      open={open === r.version}
                      onToggle={() => setOpen(open === r.version ? null : r.version)}
                      onChanged={releases.reload}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}

function ReleaseRow({ projectId, release, open, onToggle, onChanged }: { projectId: string; release: Release; open: boolean; onToggle: () => void; onChanged: () => void }) {
  return (
    <>
      <tr onClick={onToggle} className="cursor-pointer border-b border-line hover:bg-surface-hover">
        <td className="px-4 py-2.5">
          <span className="flex items-center gap-1.5 font-mono text-[12.5px] text-ink">
            {open ? <ChevronDown className="size-3.5 text-muted" /> : <ChevronRight className="size-3.5 text-muted" />}
            {release.version}
          </span>
        </td>
        <td className="whitespace-nowrap px-4 py-2.5 text-ink-2">{timeAgo(release.created_at)}</td>
        <td className="tabular px-4 py-2.5 text-right text-ink">{compact(release.new_issues)}</td>
        <td className="tabular px-4 py-2.5 text-right text-ink">{compact(release.events)}</td>
        <td className="tabular whitespace-nowrap px-4 py-2.5 text-right text-ink-2">
          {release.artifact_count ? `${release.artifact_count} · ${bytes(Number(release.artifact_bytes))}` : <span className="text-muted">none</span>}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-line bg-surface-2">
          <td colSpan={5} className="px-4 py-3">
            <Artifacts projectId={projectId} version={release.version} onChanged={onChanged} />
          </td>
        </tr>
      )}
    </>
  );
}

function Artifacts({ projectId, version, onChanged }: { projectId: string; version: string; onChanged: () => void }) {
  const path = `/api/projects/${projectId}/releases/${encodeURIComponent(version)}/artifacts`;
  const artifacts = useApi<Artifact[]>(path);
  const [busy, setBusy] = useState(false);
  if (!artifacts.data) return <Spinner />;
  if (!artifacts.data.length)
    return (
      <p className="text-sm text-ink-2">
        No source maps uploaded for this release. Stack traces from minified code will show bundle positions. Run{" "}
        <code className="font-mono text-[12px]">bugfree sourcemaps upload --release {version}</code>.
      </p>
    );
  return (
    <div className="space-y-2">
      <ul className="max-h-72 overflow-y-auto rounded-md border border-line bg-surface">
        {artifacts.data.map((a) => (
          <li key={a.id} className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs last:border-0">
            <FileCode2 className="size-3.5 shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 flex-1 truncate font-mono text-ink">{a.name}</span>
            <span className="tabular shrink-0 text-muted">{bytes(a.size)}</span>
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        variant="danger"
        loading={busy}
        onClick={async () => {
          if (!confirm(`Delete all ${artifacts.data!.length} source maps for ${version}?`)) return;
          setBusy(true);
          await api(path, { method: "DELETE" });
          setBusy(false);
          await artifacts.reload();
          onChanged();
        }}
      >
        Delete source maps
      </Button>
    </div>
  );
}

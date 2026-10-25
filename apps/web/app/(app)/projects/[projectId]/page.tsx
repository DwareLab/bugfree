"use client";

import { CheckCircle2, EyeOff, Inbox, RotateCcw, Search, Settings } from "lucide-react";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { PageHeader, useShell } from "@/components/app-shell";
import { EventsChart, Sparkline } from "@/components/charts";
import { Button, Card, EmptyState, ErrorBox, Input, LevelBadge, Segmented, Spinner, StatusBadge } from "@/components/ui";
import { type IssueList, type IssueStatus, type Point, api, useApi } from "@/lib/api";
import { compact, cx, timeAgo } from "@/lib/format";

export default function IssuesPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Issues />
    </Suspense>
  );
}

type StatusFilter = IssueStatus | "all";
type Period = "24h" | "14d" | "30d";

function Issues() {
  const { projectId } = useParams<{ projectId: string }>();
  const { projects, reloadProjects } = useShell();
  const project = projects.find((p) => p.id === Number(projectId));
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const status = (search.get("status") as StatusFilter) ?? "unresolved";
  const query = search.get("query") ?? "";
  const environment = search.get("environment") ?? "";
  const sort = search.get("sort") ?? "last_seen";
  const offset = Number(search.get("offset") ?? 0);
  const [period, setPeriod] = useState<Period>("24h");
  const [draft, setDraft] = useState(query);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => setDraft(query), [query]);

  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    if (!("offset" in patch)) next.delete("offset");
    setSelected(new Set());
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  const listPath = useMemo(() => {
    const p = new URLSearchParams({ status, sort, offset: String(offset) });
    if (query) p.set("query", query);
    if (environment) p.set("environment", environment);
    return `/api/projects/${projectId}/issues?${p}`;
  }, [projectId, status, sort, offset, query, environment]);

  const list = useApi<IssueList>(listPath, { refreshMs: 30_000 });
  const stats = useApi<{ points: Point[] }>(`/api/projects/${projectId}/stats?period=${period}`, { refreshMs: 60_000 });
  const environments = useApi<string[]>(`/api/projects/${projectId}/environments`);

  async function bulk(newStatus: IssueStatus) {
    setBusy(true);
    try {
      await api(`/api/projects/${projectId}/issues`, { method: "PATCH", json: { ids: [...selected], status: newStatus } });
      setSelected(new Set());
      await Promise.all([list.reload(), reloadProjects()]);
    } finally {
      setBusy(false);
    }
  }

  const issues = list.data?.issues ?? [];
  const allSelected = issues.length > 0 && issues.every((i) => selected.has(i.id));
  const total = stats.data?.points.reduce((a, p) => a + p.count, 0) ?? 0;

  return (
    <>
      <PageHeader
        title={project?.name ?? "Issues"}
        subtitle="Errors grouped into issues by type and stack trace."
        actions={
          <Link href={`/projects/${projectId}/settings`}>
            <Button variant="secondary">
              <Settings className="size-4" aria-hidden /> Setup
            </Button>
          </Link>
        }
      />
      <div className="space-y-4 p-4 md:p-6">
        <Card
          title={
            <span>
              Events <span className="font-normal text-muted">· {compact(total)} in the last {period === "24h" ? "24 hours" : period === "14d" ? "14 days" : "30 days"}</span>
            </span>
          }
          actions={
            <Segmented<Period>
              value={period}
              onChange={setPeriod}
              options={[
                { value: "24h", label: "24h" },
                { value: "14d", label: "14d" },
                { value: "30d", label: "30d" },
              ]}
            />
          }
        >
          <div className="px-4 py-3">{stats.data ? <EventsChart points={stats.data.points} bucket={period === "24h" ? "hour" : "day"} /> : <div className="h-[140px]" />}</div>
        </Card>

        <div className="flex flex-wrap items-center gap-2">
          <Segmented<StatusFilter>
            value={status}
            onChange={(v) => setParams({ status: v === "unresolved" ? null : v })}
            options={[
              { value: "unresolved", label: "Unresolved" },
              { value: "resolved", label: "Resolved" },
              { value: "ignored", label: "Ignored" },
              { value: "all", label: "All" },
            ]}
          />
          <form
            className="relative min-w-48 flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              setParams({ query: draft.trim() || null });
            }}
          >
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder='Search: TypeError  browser:Chrome  release:1.2.0  url:"/checkout"'
              className="pl-8"
              aria-label="Search issues"
            />
          </form>
          <select
            value={environment}
            onChange={(e) => setParams({ environment: e.target.value || null })}
            className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
            aria-label="Environment"
          >
            <option value="">All environments</option>
            {(environments.data ?? []).map((env) => (
              <option key={env} value={env}>
                {env}
              </option>
            ))}
          </select>
          <select value={sort} onChange={(e) => setParams({ sort: e.target.value })} className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink" aria-label="Sort">
            <option value="last_seen">Last seen</option>
            <option value="first_seen">First seen</option>
            <option value="times_seen">Most events</option>
            <option value="users">Most users</option>
          </select>
        </div>

        {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}

        <Card>
          <div className="flex h-11 items-center gap-3 border-b border-line px-4 text-xs text-muted">
            <input
              type="checkbox"
              aria-label="Select all"
              checked={allSelected}
              onChange={() => setSelected(allSelected ? new Set() : new Set(issues.map((i) => i.id)))}
              className="size-4 accent-[var(--accent)]"
            />
            {selected.size > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-ink-2">{selected.size} selected</span>
                {status !== "resolved" && (
                  <Button size="sm" onClick={() => bulk("resolved")} loading={busy}>
                    <CheckCircle2 className="size-3.5" aria-hidden /> Resolve
                  </Button>
                )}
                {status !== "ignored" && (
                  <Button size="sm" onClick={() => bulk("ignored")} disabled={busy}>
                    <EyeOff className="size-3.5" aria-hidden /> Ignore
                  </Button>
                )}
                {status !== "unresolved" && (
                  <Button size="sm" onClick={() => bulk("unresolved")} disabled={busy}>
                    <RotateCcw className="size-3.5" aria-hidden /> Unresolve
                  </Button>
                )}
              </div>
            ) : (
              <>
                <span className="flex-1 font-medium uppercase tracking-wider">Issue</span>
                <span className="hidden w-24 text-center font-medium uppercase tracking-wider lg:block">Last 24h</span>
                <span className="w-16 text-right font-medium uppercase tracking-wider">Events</span>
                <span className="hidden w-14 text-right font-medium uppercase tracking-wider sm:block">Users</span>
              </>
            )}
          </div>

          {!list.data && list.loading ? (
            <Spinner />
          ) : issues.length === 0 ? (
            <EmptyState icon={<Inbox className="size-8" />} title={query || environment ? "No issues match these filters" : status === "unresolved" ? "No unresolved issues" : "Nothing here"}>
              {status === "unresolved" && !query && !environment ? (
                <>
                  Either everything works, or the SDK isn&apos;t sending events yet.{" "}
                  <Link className="text-accent-ink underline" href={`/projects/${projectId}/settings`}>
                    Check the setup
                  </Link>
                  .
                </>
              ) : null}
            </EmptyState>
          ) : (
            <ul>
              {issues.map((issue) => (
                <li key={issue.id} className={cx("flex items-center gap-3 border-b border-line px-4 py-3 last:border-0 hover:bg-surface-hover", selected.has(issue.id) && "bg-accent-wash")}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${issue.title}`}
                    checked={selected.has(issue.id)}
                    onChange={() =>
                      setSelected((s) => {
                        const next = new Set(s);
                        if (next.has(issue.id)) next.delete(issue.id);
                        else next.add(issue.id);
                        return next;
                      })
                    }
                    className="size-4 shrink-0 accent-[var(--accent)]"
                  />
                  <LevelBadge level={issue.level} compact />
                  <Link href={`/issues/${issue.id}`} className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm text-ink">
                        {issue.type ? (
                          <>
                            <span className="font-semibold">{issue.type}</span>
                            <span className="text-ink-2">{issue.title.slice(issue.type.length)}</span>
                          </>
                        ) : (
                          <span className="font-semibold">{issue.title}</span>
                        )}
                      </span>
                      <StatusBadge status={issue.status} />
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
                      {issue.culprit && <span className="max-w-full truncate font-mono text-[11.5px]">{issue.culprit}</span>}
                      <span title={issue.last_seen}>{timeAgo(issue.last_seen)}</span>
                      <span title={issue.first_seen}>first {timeAgo(issue.first_seen)}</span>
                      {issue.last_release && <span className="truncate">{issue.last_release}</span>}
                    </div>
                  </Link>
                  <div className="hidden w-24 justify-center lg:flex">
                    <Sparkline values={issue.hourly} />
                  </div>
                  <span className="tabular w-16 text-right text-sm text-ink">{compact(issue.times_seen)}</span>
                  <span className="tabular hidden w-14 text-right text-sm text-ink-2 sm:block">{compact(issue.users_count)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {list.data && list.data.total > list.data.pageSize && (
          <div className="flex items-center justify-between text-sm text-ink-2">
            <span className="tabular">
              {offset + 1}–{Math.min(offset + list.data.pageSize, list.data.total)} of {list.data.total}
            </span>
            <div className="flex gap-2">
              <Button size="sm" disabled={offset === 0} onClick={() => setParams({ offset: String(Math.max(0, offset - list.data!.pageSize)) })}>
                Previous
              </Button>
              <Button size="sm" disabled={offset + list.data.pageSize >= list.data.total} onClick={() => setParams({ offset: String(offset + list.data!.pageSize) })}>
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

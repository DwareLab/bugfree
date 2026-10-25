"use client";

import { ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, EyeOff, RotateCcw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { useShell } from "@/components/app-shell";
import { EventsChart } from "@/components/charts";
import { EventView } from "@/components/event-view";
import { Button, Card, CopyButton, ErrorBox, LevelBadge, Segmented, Spinner, StatusBadge } from "@/components/ui";
import { type EventRow, type IssueDetail, type IssueStatus, type StoredEvent, api, useApi } from "@/lib/api";
import { compact, cx, formatDate, timeAgo } from "@/lib/format";

export default function IssuePage() {
  const { issueId } = useParams<{ issueId: string }>();
  const router = useRouter();
  const { reloadProjects } = useShell();
  const issue = useApi<IssueDetail>(`/api/issues/${issueId}`, { refreshMs: 30_000 });
  const [which, setWhich] = useState<string>("latest");
  const [tab, setTab] = useState<"event" | "events">("event");
  const [chart, setChart] = useState<"24h" | "30d">("24h");
  const [busy, setBusy] = useState(false);
  const event = useApi<StoredEvent>(`/api/issues/${issueId}/events/${which}`);

  async function setStatus(status: IssueStatus) {
    setBusy(true);
    try {
      await api(`/api/issues/${issueId}`, { method: "PATCH", json: { status } });
      await Promise.all([issue.reload(), reloadProjects()]);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!issue.data || !confirm("Delete this issue and all its events? New events will create it again.")) return;
    await api(`/api/issues/${issueId}`, { method: "DELETE" });
    await reloadProjects();
    router.replace(`/projects/${issue.data.project_id}`);
  }

  if (issue.error) return <div className="p-6"><ErrorBox error={issue.error} onRetry={issue.reload} /></div>;
  if (!issue.data) return <Spinner />;
  const i = issue.data;

  return (
    <>
      <div className="border-b border-line bg-surface px-4 pt-3 pb-4 md:px-6">
        <Link href={`/projects/${i.project_id}`} className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
          <ArrowLeft className="size-3.5" aria-hidden /> {i.project_name}
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <LevelBadge level={i.level} />
              <StatusBadge status={i.status} />
              <span className="text-xs text-muted">#{i.id}</span>
            </div>
            <h1 className="mt-1 break-words text-lg font-semibold tracking-tight text-ink">
              {i.type ?? i.title}
              {i.type && i.value ? <span className="font-normal text-ink-2">: {i.value.split("\n")[0]}</span> : null}
            </h1>
            {i.culprit && <p className="mt-0.5 truncate font-mono text-xs text-ink-2">{i.culprit}</p>}
            {i.status === "resolved" && i.resolved_at && i.last_seen > i.resolved_at && (
              <p className="mt-1.5 text-xs text-muted">
                Seen since it was resolved, from releases that already had it (e.g. stale browser tabs). An event from a new
                release reopens it.
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {i.status === "unresolved" ? (
              <>
                <Button variant="primary" onClick={() => setStatus("resolved")} loading={busy}>
                  <CheckCircle2 className="size-4" aria-hidden /> Resolve
                </Button>
                <Button onClick={() => setStatus("ignored")} disabled={busy}>
                  <EyeOff className="size-4" aria-hidden /> Ignore
                </Button>
              </>
            ) : (
              <Button onClick={() => setStatus("unresolved")} loading={busy}>
                <RotateCcw className="size-4" aria-hidden /> Unresolve
              </Button>
            )}
            <Button variant="danger" onClick={remove} aria-label="Delete issue">
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </div>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Events" value={compact(i.times_seen)} />
          <Stat label="Users" value={compact(i.users_count)} />
          <Stat label="First seen" value={timeAgo(i.first_seen)} title={formatDate(i.first_seen)} />
          <Stat label="Last seen" value={timeAgo(i.last_seen)} title={formatDate(i.last_seen)} />
          <Stat label="First release" value={i.first_release ?? "—"} />
          <Stat label="Last release" value={i.last_release ?? "—"} />
        </dl>
      </div>

      <div className="grid gap-4 p-4 md:p-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-4">
          <Card
            title={`Events · ${chart === "24h" ? "last 24 hours" : "last 30 days"}`}
            actions={
              <Segmented
                value={chart}
                onChange={setChart}
                options={[
                  { value: "24h", label: "24h" },
                  { value: "30d", label: "30d" },
                ]}
              />
            }
          >
            <div className="px-4 py-3">
              <EventsChart points={chart === "24h" ? i.stats.hourly : i.stats.daily} bucket={chart === "24h" ? "hour" : "day"} height={120} />
            </div>
          </Card>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                { value: "event", label: "Event details" },
                { value: "events", label: `All events (${compact(i.stored_events)})` },
              ]}
            />
            {tab === "event" && event.data && (
              <div className="flex items-center gap-1">
                <span className="mr-2 hidden text-xs text-muted sm:inline">
                  <span className="font-mono">{event.data.event_id.slice(0, 12)}</span> · {formatDate(event.data.occurred_at)}
                </span>
                <NavButton label="Oldest" disabled={!event.data.prev_id} onClick={() => setWhich("oldest")}>
                  <ChevronsLeft className="size-4" />
                </NavButton>
                <NavButton label="Older" disabled={!event.data.prev_id} onClick={() => setWhich(String(event.data!.prev_id))}>
                  <ChevronLeft className="size-4" />
                </NavButton>
                <NavButton label="Newer" disabled={!event.data.next_id} onClick={() => setWhich(String(event.data!.next_id))}>
                  <ChevronRight className="size-4" />
                </NavButton>
                <NavButton label="Latest" disabled={!event.data.next_id} onClick={() => setWhich("latest")}>
                  <ChevronsRight className="size-4" />
                </NavButton>
              </div>
            )}
          </div>

          {tab === "event" ? (
            event.error ? (
              <ErrorBox error={event.error} />
            ) : !event.data ? (
              <Spinner label="Loading event" />
            ) : (
              <div className={cx(event.loading && "opacity-60 transition-opacity")}>
                <EventView event={event.data} />
              </div>
            )
          ) : (
            <EventList
              issueId={issueId}
              onPick={(id) => {
                setWhich(String(id));
                setTab("event");
              }}
            />
          )}
        </div>

        <aside className="space-y-4">
          <TagsPanel tags={i.tags} />
          {event.data && (
            <Card title="Event ID">
              <div className="flex items-center justify-between gap-2 px-4 py-3">
                <code className="truncate font-mono text-xs text-ink">{event.data.event_id}</code>
                <CopyButton text={event.data.event_id} />
              </div>
            </Card>
          )}
          {event.data && <LogsAround projectId={i.project_id} event={event.data} />}
        </aside>
      </div>
    </>
  );
}

/** Links to the container logs written around this event. */
function LogsAround({ projectId, event }: { projectId: number; event: StoredEvent }) {
  const t = new Date(event.occurred_at).getTime();
  const href = (extra: Record<string, string> = {}) =>
    `/projects/${projectId}/logs?${new URLSearchParams({ from: new Date(t - 5 * 60_000).toISOString(), to: new Date(t + 60_000).toISOString(), at: event.occurred_at, ...extra })}`;
  // In Docker, the SDK's server_name (the hostname) is the short container id.
  const containerId = /^[0-9a-f]{12}$/.test(event.data.server_name ?? "") ? event.data.server_name : undefined;
  return (
    <Card title="Logs around this event">
      <div className="space-y-1.5 px-4 py-3 text-sm">
        <p className="text-xs text-muted">5 minutes before to 1 minute after.</p>
        {containerId && (
          <Link href={href({ query: `container_id:${containerId}` })} className="block text-accent-ink hover:underline">
            This container
          </Link>
        )}
        <Link href={href()} className="block text-accent-ink hover:underline">
          All containers
        </Link>
      </div>
    </Card>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="truncate font-medium text-ink" title={title ?? value}>
        {value}
      </dd>
    </div>
  );
}

function NavButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded-md border border-line bg-surface p-1.5 text-ink-2 hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

const TAG_ORDER = ["environment", "release", "browser", "os", "device", "url", "transaction", "runtime", "server_name", "handled", "mechanism"];

function TagsPanel({ tags }: { tags: IssueDetail["tags"] }) {
  const keys = Object.keys(tags)
    .filter((k) => k !== "level" && k !== "browser.name")
    .sort((a, b) => {
      const ia = TAG_ORDER.indexOf(a);
      const ib = TAG_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
  if (!keys.length) return null;
  return (
    <Card title="Tags">
      <div className="space-y-4 p-4">
        {keys.map((key) => {
          const t = tags[key];
          return (
            <div key={key}>
              <div className="mb-1.5 text-xs font-medium text-ink-2">{key}</div>
              <ul className="space-y-1">
                {t.values.map((v) => {
                  const pct = t.total ? Math.round((v.count / t.total) * 100) : 0;
                  return (
                    <li key={v.value} className="relative overflow-hidden rounded" title={`${v.value}: ${v.count} events (${pct}%)`}>
                      <div className="absolute inset-y-0 left-0 rounded bg-accent-wash" style={{ width: `${pct}%` }} aria-hidden />
                      <div className="relative flex items-center justify-between gap-2 px-2 py-0.5 text-xs">
                        <span className="truncate font-mono text-ink">{v.value}</span>
                        <span className="tabular shrink-0 text-ink-2">{pct}%</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function EventList({ issueId, onPick }: { issueId: string; onPick: (id: number) => void }) {
  const [before, setBefore] = useState<number | null>(null);
  const page = useApi<{ events: EventRow[]; next: number | null }>(`/api/issues/${issueId}/events${before ? `?before=${before}` : ""}`);
  if (!page.data) return <Spinner />;
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="px-4 py-2 font-medium">Event</th>
              <th className="px-4 py-2 font-medium">Time</th>
              <th className="px-4 py-2 font-medium">Environment</th>
              <th className="px-4 py-2 font-medium">Release</th>
              <th className="px-4 py-2 font-medium">User</th>
              <th className="px-4 py-2 font-medium">URL / route</th>
            </tr>
          </thead>
          <tbody>
            {page.data.events.map((e) => (
              <tr key={e.id} onClick={() => onPick(e.id)} className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-hover">
                <td className="px-4 py-2 font-mono text-xs text-accent-ink">{e.event_id.slice(0, 10)}</td>
                <td className="whitespace-nowrap px-4 py-2 text-ink-2" title={formatDate(e.occurred_at)}>
                  {timeAgo(e.occurred_at)}
                </td>
                <td className="px-4 py-2 text-ink-2">{e.environment ?? "—"}</td>
                <td className="max-w-40 truncate px-4 py-2 text-ink-2">{e.release ?? "—"}</td>
                <td className="max-w-40 truncate px-4 py-2 text-ink-2">{e.user_key?.replace(/^\w+:/, "") ?? "—"}</td>
                <td className="max-w-72 truncate px-4 py-2 font-mono text-xs text-ink-2">{e.transaction_name ?? e.url ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(before || page.data.next) && (
        <div className="flex justify-end gap-2 border-t border-line px-4 py-2">
          {before && (
            <Button size="sm" onClick={() => setBefore(null)}>
              Newest
            </Button>
          )}
          {page.data.next && (
            <Button size="sm" onClick={() => setBefore(page.data!.next)}>
              Older
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

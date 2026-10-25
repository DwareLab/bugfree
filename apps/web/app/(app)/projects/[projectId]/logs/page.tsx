"use client";

import { ArrowUp, CornerDownRight, Filter, ListTree, Pause, Play, RefreshCw, ScrollText, Search } from "lucide-react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader, useShell } from "@/components/app-shell";
import { EventsChart } from "@/components/charts";
import { DockerLogsSetup } from "@/components/docker-logs-setup";
import { Button, Card, CopyButton, EmptyState, ErrorBox, Input, Spinner } from "@/components/ui";
import { type Level, type LogLine, type LogPage, type LogSource, type LogVolume, type Project, api, useApi } from "@/lib/api";
import { compact, cx, formatDate, timeAgo } from "@/lib/format";

export default function LogsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Logs />
    </Suspense>
  );
}

const RANGES = {
  "15m": { ms: 15 * 60_000, label: "Last 15 minutes" },
  "1h": { ms: 3_600_000, label: "Last hour" },
  "6h": { ms: 6 * 3_600_000, label: "Last 6 hours" },
  "24h": { ms: 86_400_000, label: "Last 24 hours" },
  "7d": { ms: 7 * 86_400_000, label: "Last 7 days" },
  "14d": { ms: 14 * 86_400_000, label: "Last 14 days" },
} as const;
type Range = keyof typeof RANGES;

const LIVE_MS = 2500;
/** Live tail keeps this many lines in memory; older ones are reloaded through "Load older". */
const MAX_ROWS = 2000;

function sortLines(lines: LogLine[]): LogLine[] {
  const seen = new Set<number>();
  return lines
    .filter((l) => !seen.has(l.id) && seen.add(l.id))
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.id - a.id));
}

/** An ISO time in the rows' format (UTC, 6 fractional digits), so the two compare as strings. */
function toMicros(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(iso);
  if (m) return `${m[1]}.${(m[2] ?? "").padEnd(6, "0").slice(0, 6)}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : toMicros(d.toISOString());
}

function Logs() {
  const { projectId } = useParams<{ projectId: string }>();
  const { projects } = useShell();
  const project = projects.find((p) => p.id === Number(projectId));
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const query = search.get("query") ?? "";
  const container = search.get("container") ?? "";
  const level = search.get("level") ?? "";
  const customFrom = search.get("from");
  const customTo = search.get("to");
  /** A moment to mark in the list (the line "Surrounding lines" came from, or an issue's event). */
  const at = search.get("at");
  const range: Range = (search.get("range") as Range) in RANGES ? (search.get("range") as Range) : "24h";
  const [draft, setDraft] = useState(query);
  const [live, setLive] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => setDraft(query), [query]);

  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    if (!("at" in patch)) next.delete("at");
    setOpen(null);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  // The absolute window is fixed when the filters change (or on refresh), so paging stays consistent.
  const span = useMemo(() => {
    void refreshKey;
    if (customFrom) return { from: customFrom, to: customTo ?? undefined };
    return { from: new Date(Date.now() - RANGES[range].ms).toISOString(), to: undefined };
  }, [customFrom, customTo, range, refreshKey]);

  const filterQs = useMemo(() => {
    const p = new URLSearchParams();
    if (query) p.set("query", query);
    if (container) p.set("container", container);
    if (level) p.set("level", level);
    p.set("from", span.from);
    if (span.to) p.set("to", span.to);
    return p.toString();
  }, [query, container, level, span]);

  const sources = useApi<LogSource[]>(`/api/projects/${projectId}/logs/sources`, { refreshMs: 60_000 });
  const volume = useApi<LogVolume>(`/api/projects/${projectId}/logs/volume?${filterQs}`);
  const noLogsYet = sources.data?.length === 0;
  const projectDetail = useApi<Project>(noLogsYet ? `/api/projects/${projectId}` : null);

  const listPath = `/api/projects/${projectId}/logs?${filterQs}`;
  const [rows, setRows] = useState<LogLine[] | null>(null);
  /** The list path `rows` were loaded for (they stay on screen while the next filters load). */
  const [rowsFor, setRowsFor] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pending, setPending] = useState<LogLine[]>([]);
  const rowsRef = useRef<LogLine[]>([]);
  rowsRef.current = rows ?? [];
  const pendingRef = useRef<LogLine[]>([]);
  pendingRef.current = pending;
  /** The held-back lines don't connect to the list (a burst bigger than one poll): showing them means reloading. */
  const pendingGap = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPending([]);
    pendingGap.current = false;
    api<LogPage>(listPath)
      .then((page) => {
        if (cancelled) return;
        setRows(page.logs);
        setRowsFor(listPath);
        setNext(page.next);
        setError(null);
      })
      .catch((err: Error) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [listPath]);

  const prepend = useCallback((lines: LogLine[]) => {
    setRows((prev) => {
      const merged = sortLines([...lines, ...(prev ?? [])]);
      if (merged.length <= MAX_ROWS) return merged;
      const kept = merged.slice(0, MAX_ROWS);
      const last = kept[kept.length - 1];
      setNext(`${last.ts}|${last.id}`);
      return kept;
    });
  }, []);

  // Live tail: poll for lines stored after the newest one shown. While the reader is scrolled down, hold them back.
  const canLive = !span.to;
  const volumeAt = useRef(0);
  const reloadVolume = volume.reload;
  useEffect(() => {
    if (!live || !canLive) return;
    const t = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      const newest = Math.max(0, ...rowsRef.current.map((r) => r.id), ...pendingRef.current.map((r) => r.id));
      const page = await api<LogPage>(`${listPath}&after_id=${newest}`).catch(() => null);
      if (!page?.logs.length) return;
      const held = globalThis.scrollY > 240 || pendingRef.current.length > 0;
      if (page.next || (held && pendingRef.current.length + page.logs.length > MAX_ROWS)) {
        // More arrived than one poll returns: splicing would leave a gap, so start over from the newest lines.
        if (held) {
          pendingGap.current = true;
          setPending((p) => sortLines([...page.logs, ...p]).slice(0, MAX_ROWS));
        } else {
          setRows(page.logs);
          setNext(page.next);
        }
        return;
      }
      // Once lines are held back, keep queueing behind them so the list never has a gap.
      if (held) setPending((p) => sortLines([...page.logs, ...p]));
      else prepend(page.logs);
      if (Date.now() - volumeAt.current > 15_000) {
        volumeAt.current = Date.now();
        void reloadVolume();
      }
    }, LIVE_MS);
    return () => clearInterval(t);
  }, [live, canLive, listPath, prepend, reloadVolume]);

  async function loadMore() {
    if (!next) return;
    setLoadingMore(true);
    try {
      const page = await api<LogPage>(`${listPath}&before=${encodeURIComponent(next)}`);
      setRows((prev) => sortLines([...(prev ?? []), ...page.logs]));
      setNext(page.next);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoadingMore(false);
    }
  }

  const terms = useMemo(
    () =>
      (query.match(/\S+?:"[^"]*"|"[^"]*"|\S+/g) ?? [])
        .filter((t) => !/^[A-Za-z_@][\w.@-]*:/.test(t))
        .map((t) => t.replace(/^"|"$/g, ""))
        .filter(Boolean),
    [query],
  );
  const total = volume.data?.points.reduce((a, p) => a + p.count, 0) ?? 0;
  const errors = volume.data?.points.reduce((a, p) => a + p.errors, 0) ?? 0;
  const bucket = !volume.data ? "hour" : volume.data.bucket_seconds < 3600 ? "minute" : volume.data.bucket_seconds < 86400 ? "hour" : "day";
  const rangeLabel = customFrom ? `${formatDate(customFrom)} – ${customTo ? formatDate(customTo) : "now"}` : RANGES[range].label.toLowerCase();

  // Rows are newest first: the marker goes before the first row at or before `at`.
  const anchorIndex = at && rows ? rows.findIndex((r) => r.ts <= toMicros(at)) : -1;
  const anchorRef = useRef<HTMLDivElement>(null);
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!at || rowsFor !== listPath || anchorIndex < 0 || scrolledTo.current === at || !anchorRef.current) return;
    scrolledTo.current = at;
    anchorRef.current.scrollIntoView({ block: "center" });
  }, [at, anchorIndex, rowsFor, listPath]);

  const showContext = (line: LogLine) => {
    const t = new Date(line.ts).getTime();
    setParams({
      container: line.container,
      query: null,
      level: null,
      range: null,
      // Mostly what led up to the line, so it lands on the first page.
      from: new Date(t - 3 * 60_000).toISOString(),
      to: new Date(t + 30_000).toISOString(),
      at: line.ts,
    });
  };
  const addFilter = (key: string, value: string) => {
    const term = `${key}:${/\s/.test(value) ? `"${value}"` : value}`;
    setParams({ query: query.includes(term) ? query : `${query} ${term}`.trim() });
  };

  if (noLogsYet) {
    return (
      <>
        <PageHeader title={`${project?.name ?? "Project"} · Logs`} subtitle="Container logs, kept after Docker restarts and re-creates." />
        <div className="mx-auto max-w-4xl space-y-4 p-4 md:p-6">
          <Card>
            <EmptyState icon={<ScrollText className="size-8" />} title="No logs yet">
              Start the Docker log agent on each host that runs your containers. Lines show up here within a couple of seconds.
            </EmptyState>
          </Card>
          <Card title="Collect Docker logs">
            <div className="p-4">{projectDetail.data ? <DockerLogsSetup project={projectDetail.data} /> : <Spinner />}</div>
          </Card>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={`${project?.name ?? "Project"} · Logs`}
        subtitle="Container logs, kept after Docker restarts and re-creates."
        actions={
          <>
            <Button onClick={() => setRefreshKey((k) => k + 1)} aria-label="Refresh" title="Refresh">
              <RefreshCw className={cx("size-4", loading && "animate-spin")} aria-hidden />
            </Button>
            <Button
              variant={live ? "primary" : "secondary"}
              onClick={() => {
                if (!live && !canLive) setParams({ from: null, to: null, range: "15m" });
                setLive((l) => !l);
              }}
              aria-pressed={live}
              title={canLive ? "Stream new lines as they arrive" : "Switches to the last 15 minutes"}
            >
              {live ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
              {live ? "Live" : "Go live"}
            </Button>
          </>
        }
      />
      <div className="space-y-4 p-4 md:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <form
            className="relative min-w-56 flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              setParams({ query: draft.trim() || null });
            }}
          >
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder='Search: timeout  "payment declined"  service:api  orderId:42'
              className="pl-8 font-mono text-[13px]"
              aria-label="Search logs"
            />
          </form>
          <select
            value={container}
            onChange={(e) => setParams({ container: e.target.value || null })}
            className="h-9 max-w-56 rounded-md border border-line bg-surface px-2 text-sm text-ink"
            aria-label="Container"
          >
            <option value="">All containers</option>
            {container && !sources.data?.some((s) => s.container === container) && <option value={container}>{container}</option>}
            {(sources.data ?? []).map((s) => (
              <option key={s.container} value={s.container}>
                {s.container}
                {Date.now() - new Date(s.last_seen).getTime() > 10 * 60_000 ? ` · last line ${timeAgo(s.last_seen)}` : ""}
              </option>
            ))}
          </select>
          <select
            value={level}
            onChange={(e) => setParams({ level: e.target.value || null })}
            className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
            aria-label="Minimum level"
          >
            <option value="">Any level</option>
            <option value="warning">Warnings and errors</option>
            <option value="error">Errors only</option>
          </select>
          <select
            value={customFrom ? "custom" : range}
            onChange={(e) => setParams({ range: e.target.value === "24h" ? null : e.target.value, from: null, to: null })}
            className="h-9 rounded-md border border-line bg-surface px-2 text-sm text-ink"
            aria-label="Time range"
          >
            {customFrom && <option value="custom">Custom range</option>}
            {(Object.keys(RANGES) as Range[]).map((r) => (
              <option key={r} value={r}>
                {RANGES[r].label}
              </option>
            ))}
          </select>
        </div>

        <Card
          title={
            <span>
              Log volume{" "}
              <span className="font-normal text-muted">
                · {compact(total)} lines, {compact(errors)} errors · {rangeLabel}
              </span>
            </span>
          }
          actions={
            <span className="flex items-center gap-3 text-xs text-muted">
              <span className="flex items-center gap-1.5">
                <span className="inline-block size-2 rounded-sm bg-[var(--series)]" aria-hidden /> lines
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block size-2 rounded-sm bg-critical" aria-hidden /> errors
              </span>
            </span>
          }
        >
          <div className="px-4 py-3">
            {volume.data ? <EventsChart points={volume.data.points} bucket={bucket} height={110} label="Lines" errorsLabel="errors" /> : <div className="h-[110px]" />}
          </div>
        </Card>

        {error && <ErrorBox error={error} onRetry={() => setRefreshKey((k) => k + 1)} />}

        {pending.length > 0 && (
          <div className="sticky top-14 z-10 flex justify-center md:top-3">
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                // Can't splice them in without a gap: reload from the newest lines instead.
                if (pendingGap.current) setRefreshKey((k) => k + 1);
                else prepend(pending);
                pendingGap.current = false;
                setPending([]);
                globalThis.scrollTo({ top: 0, behavior: "smooth" });
              }}
            >
              <ArrowUp className="size-3.5" aria-hidden /> {compact(pending.length)}
              {pendingGap.current ? "+" : ""} new line{pending.length === 1 ? "" : "s"}
            </Button>
          </div>
        )}

        <Card>
          {!rows ? (
            <Spinner label="Loading logs" />
          ) : rows.length === 0 ? (
            <EmptyState icon={<ScrollText className="size-8" />} title="No log lines match">
              {live ? "Waiting for new lines…" : "Try a longer time range or fewer filters."}
            </EmptyState>
          ) : (
            <div className={cx("divide-y divide-line", loading && "opacity-60 transition-opacity")}>
              {rows.map((line, i) => (
                <Fragment key={line.id}>
                  {i === anchorIndex && at && (
                    <div ref={anchorRef} className="flex items-center gap-1.5 bg-accent-wash px-3 py-1 font-mono text-[11px] font-medium text-accent-ink">
                      <CornerDownRight className="size-3.5" aria-hidden /> {lineTime(at)}
                    </div>
                  )}
                  <LogRow
                    line={line}
                    terms={terms}
                    open={open === line.id}
                    onToggle={() => setOpen(open === line.id ? null : line.id)}
                    onContext={() => showContext(line)}
                    onFilter={addFilter}
                  />
                </Fragment>
              ))}
            </div>
          )}
          {rows && rows.length > 0 && (
            <div className="flex items-center justify-center border-t border-line px-4 py-3">
              {next ? (
                <Button size="sm" onClick={loadMore} loading={loadingMore}>
                  Load older lines
                </Button>
              ) : (
                <span className="text-xs text-muted">Start of the selected range</span>
              )}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

const LEVEL_TEXT: Record<Level, string> = { fatal: "FATAL", error: "ERROR", warning: "WARN", info: "INFO", debug: "DEBUG" };

function lineTime(iso: string): string {
  const d = new Date(iso);
  const t = `${d.toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${t}`;
}

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 ? (
          <mark key={i} className="rounded-sm bg-accent-wash text-ink">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

function LogRow({
  line,
  terms,
  open,
  onToggle,
  onContext,
  onFilter,
}: {
  line: LogLine;
  terms: string[];
  open: boolean;
  onToggle: () => void;
  onContext: () => void;
  onFilter: (key: string, value: string) => void;
}) {
  const severe = line.level === "error" || line.level === "fatal";
  const lines = line.message.split("\n");
  const source = line.container ?? line.host ?? "—";
  return (
    <div className={cx(open && "bg-surface-2", severe ? "shadow-[inset_2px_0_var(--critical)]" : line.level === "warning" && "shadow-[inset_2px_0_var(--warning)]")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full flex-wrap items-baseline gap-x-3 px-3 py-1 text-left font-mono text-[12px] leading-5 hover:bg-surface-hover sm:flex-nowrap"
      >
        <span className="tabular shrink-0 text-muted" title={formatDate(line.ts)}>
          {lineTime(line.ts)}
        </span>
        <span className={cx("w-10 shrink-0 text-[11px] font-semibold", severe ? "text-critical-ink" : line.level === "warning" ? "text-ink" : "text-muted")}>
          {LEVEL_TEXT[line.level] ?? line.level}
        </span>
        <span className="min-w-0 shrink-0 truncate text-ink-2 sm:w-40" title={source}>
          {source}
        </span>
        <span className={cx("w-full min-w-0 text-ink sm:w-auto sm:flex-1", open ? "whitespace-pre-wrap break-words" : "truncate")}>
          <Highlight text={open ? line.message : lines[0]} terms={terms} />
          {!open && lines.length > 1 && <span className="text-muted"> +{lines.length - 1} lines</span>}
        </span>
      </button>
      {open && <LogDetails line={line} onContext={onContext} onFilter={onFilter} />}
    </div>
  );
}

function LogDetails({ line, onContext, onFilter }: { line: LogLine; onContext: () => void; onFilter: (key: string, value: string) => void }) {
  const meta: Array<[string, string | null, string?]> = [
    ["Time", `${line.ts.replace("T", " ").replace("Z", " UTC")}`],
    ["Container", line.container, "container"],
    ["Service", line.service, "service"],
    ["Image", line.image, "image"],
    ["Container ID", line.container_id, "container_id"],
    ["Host", line.host, "host"],
    ["Stream", line.stream, "stream"],
  ];
  const attrs = Object.entries(line.attributes ?? {});
  const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  return (
    <div className="space-y-3 px-3 pt-1 pb-3 sm:pl-6">
      <div className="flex flex-wrap gap-2">
        {line.container && (
          <Button size="sm" onClick={onContext}>
            <ListTree className="size-3.5" aria-hidden /> Surrounding lines
          </Button>
        )}
        <CopyButton text={line.message} label="Copy message" />
      </div>
      {attrs.length > 0 && (
        <FieldTable title="Fields" rows={attrs.map(([k, v]) => [k, show(v), typeof v === "object" && v !== null ? undefined : k])} onFilter={onFilter} />
      )}
      <FieldTable title="Source" rows={meta.filter(([, v]) => v)} onFilter={onFilter} />
    </div>
  );
}

function FieldTable({ title, rows, onFilter }: { title: string; rows: Array<[string, string | null, string?]>; onFilter: (key: string, value: string) => void }) {
  return (
    <div>
      <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</h4>
      <table className="w-full max-w-3xl text-xs">
        <tbody>
          {rows.map(([k, v, filterKey]) => (
            <tr key={k} className="group border-t border-line first:border-0">
              <th scope="row" className="w-24 py-1 pr-3 text-left align-top font-normal text-muted sm:w-36">
                {k}
              </th>
              <td className="py-1 font-mono break-all text-ink">{v}</td>
              <td className="w-8 py-0.5 text-right align-top">
                {filterKey && v && (
                  <button
                    type="button"
                    onClick={() => onFilter(filterKey, v)}
                    className="rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:bg-surface-hover hover:text-ink focus-visible:opacity-100"
                    aria-label={`Filter by ${k} ${v}`}
                    title={`Filter: ${filterKey}:${v}`}
                  >
                    <Filter className="size-3" aria-hidden />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

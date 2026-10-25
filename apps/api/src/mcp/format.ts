// Renders issues and events as compact Markdown for MCP clients: what an agent needs to debug, without the JSON noise.

interface Frame {
  filename?: string;
  abs_path?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
  pre_context?: string[];
  context_line?: string;
  post_context?: string[];
  mapped?: boolean;
}

interface ExceptionValue {
  type: string;
  value: string;
  stacktrace?: { frames: Frame[] };
  mechanism?: { type: string; handled: boolean };
}

interface Breadcrumb {
  timestamp: string;
  type?: string;
  category?: string;
  message?: string;
  level?: string;
  data?: Record<string, unknown>;
}

export interface EventData {
  event_id: string;
  level?: string;
  environment?: string;
  release?: string;
  server_name?: string;
  transaction?: string;
  message?: string;
  exception?: { values: ExceptionValue[] };
  breadcrumbs?: Breadcrumb[];
  request?: { method?: string; url?: string; query_string?: string; data?: unknown };
  user?: Record<string, unknown>;
  tags?: Record<string, string>;
  contexts?: Record<string, Record<string, unknown>>;
  extra?: Record<string, unknown>;
}

export interface StoredEvent {
  id: number;
  event_id: string;
  issue_id: number;
  occurred_at: Date | string;
  data: EventData;
  prev_id?: number | null;
  next_id?: number | null;
}

const MAX_FRAMES = 40;
const MAX_BREADCRUMBS = 20;
const MAX_JSON = 2000;

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : "–");

function json(value: unknown): string {
  const s = JSON.stringify(value, null, 2) ?? "";
  return s.length > MAX_JSON ? `${s.slice(0, MAX_JSON)}\n… (truncated)` : s;
}

function frameLine(f: Frame): string {
  const where = [f.filename ?? f.abs_path ?? "<unknown>", f.lineno, f.colno].filter((v) => v !== undefined).join(":");
  return `at ${f.function || "<anonymous>"} (${where})${f.in_app ? "" : " [library]"}`;
}

/** Stack trace, most recent call first. Source context is shown for in-app frames only. */
export function formatException(exc: ExceptionValue): string {
  const lines = [`${exc.type}: ${exc.value}`];
  if (exc.mechanism) lines[0] += `  (${exc.mechanism.type}, ${exc.mechanism.handled ? "handled" : "unhandled"})`;
  const frames = exc.stacktrace?.frames ?? [];
  for (const f of frames.slice(0, MAX_FRAMES)) {
    lines.push(`  ${frameLine(f)}`);
    if (f.in_app && f.context_line !== undefined && f.lineno !== undefined) {
      const pre = f.pre_context ?? [];
      const start = f.lineno - pre.length;
      [...pre, f.context_line, ...(f.post_context ?? [])].forEach((src, i) => {
        const n = start + i;
        lines.push(`    ${n === f.lineno ? ">" : " "} ${String(n).padStart(5)} | ${src}`);
      });
    }
  }
  if (frames.length > MAX_FRAMES) lines.push(`  … ${frames.length - MAX_FRAMES} more frames`);
  return lines.join("\n");
}

function formatBreadcrumb(b: Breadcrumb): string {
  const label = [b.type && b.type !== "default" ? b.type : undefined, b.category].filter(Boolean).join("/") || "log";
  const data = b.data && Object.keys(b.data).length ? ` ${JSON.stringify(b.data)}` : "";
  return `- ${b.timestamp} [${label}${b.level && b.level !== "info" ? ` ${b.level}` : ""}] ${b.message ?? ""}${data}`.trimEnd();
}

export function formatEvent(event: StoredEvent): string {
  const d = event.data;
  const out: string[] = [];
  out.push(`## Event ${event.id} (event_id ${event.event_id})`);
  const meta = [
    `occurred: ${iso(event.occurred_at)}`,
    d.level && `level: ${d.level}`,
    d.environment && `environment: ${d.environment}`,
    d.release && `release: ${d.release}`,
    d.transaction && `transaction: ${d.transaction}`,
    d.server_name && `server: ${d.server_name}`,
  ].filter(Boolean);
  out.push(meta.join(" · "));
  if (event.prev_id !== undefined || event.next_id !== undefined) {
    out.push(`older event: ${event.prev_id ?? "none"} · newer event: ${event.next_id ?? "none"}`);
  }

  const values = d.exception?.values ?? [];
  if (values.length) {
    out.push("", "### Exception (most recent call first)", "```");
    out.push(values.map((v, i) => (i ? `Caused by: ${formatException(v)}` : formatException(v))).join("\n\n"));
    out.push("```");
  } else if (d.message) {
    out.push("", "### Message", d.message);
  }

  if (d.request?.url || d.request?.method) {
    out.push("", "### Request", `${d.request.method ?? "GET"} ${d.request.url ?? ""}${d.request.query_string ? `?${d.request.query_string}` : ""}`);
    if (d.request.data !== undefined) out.push("```json", json(d.request.data), "```");
  }

  const crumbs = d.breadcrumbs ?? [];
  if (crumbs.length) {
    const shown = crumbs.slice(-MAX_BREADCRUMBS);
    out.push("", `### Breadcrumbs (oldest first${crumbs.length > shown.length ? `, last ${shown.length} of ${crumbs.length}` : ""})`);
    out.push(...shown.map(formatBreadcrumb));
  }

  if (d.user && Object.keys(d.user).length) out.push("", "### User", "```json", json(d.user), "```");
  if (d.tags && Object.keys(d.tags).length) {
    out.push("", "### Tags", Object.entries(d.tags).map(([k, v]) => `${k}=${v}`).join(", "));
  }
  if (d.contexts && Object.keys(d.contexts).length) out.push("", "### Contexts", "```json", json(d.contexts), "```");
  if (d.extra && Object.keys(d.extra).length) out.push("", "### Extra", "```json", json(d.extra), "```");
  return out.join("\n");
}

export interface IssueSummary {
  id: number;
  title: string;
  culprit: string | null;
  level: string;
  status: string;
  times_seen: number;
  users_count: number;
  first_seen: Date | string;
  last_seen: Date | string;
  first_release?: string | null;
  last_release?: string | null;
}

export function formatIssueRow(i: IssueSummary): string {
  const status = i.status === "unresolved" ? "" : ` [${i.status}]`;
  return (
    `- #${i.id} ${i.title}${status}\n` +
    `  ${i.culprit ? `in ${i.culprit} · ` : ""}${i.level} · ${i.times_seen} events · ${i.users_count} users · ` +
    `first ${iso(i.first_seen)} · last ${iso(i.last_seen)}`
  );
}

export interface IssueDetail extends IssueSummary {
  project_id: number;
  project_name: string;
  type: string | null;
  value: string | null;
  resolved_at: Date | string | null;
  stored_events: number;
  tags: Record<string, { total: number; values: Array<{ value: string; count: number }> }>;
  stats: { hourly: Array<{ count: number }>; daily: Array<{ count: number }> };
}

export function formatIssue(issue: IssueDetail, link: string): string {
  const sum = (pts: Array<{ count: number }>) => pts.reduce((n, p) => n + p.count, 0);
  const out = [
    `# Issue #${issue.id}: ${issue.title}`,
    `project: ${issue.project_name} (id ${issue.project_id}) · status: ${issue.status}${issue.resolved_at ? ` since ${iso(issue.resolved_at)}` : ""} · level: ${issue.level}`,
    issue.culprit ? `culprit: ${issue.culprit}` : "",
    `events: ${issue.times_seen} total, ${sum(issue.stats.hourly)} in the last 24h, ${sum(issue.stats.daily)} in 30 days · users affected: ${issue.users_count}`,
    `first seen: ${iso(issue.first_seen)}${issue.first_release ? ` (release ${issue.first_release})` : ""} · last seen: ${iso(issue.last_seen)}${issue.last_release ? ` (release ${issue.last_release})` : ""}`,
    `stored events: ${issue.stored_events} (older ones are removed by retention)`,
    `dashboard: ${link}`,
  ].filter(Boolean);
  const tagKeys = Object.keys(issue.tags).sort();
  if (tagKeys.length) {
    out.push("", "## Tags (top values)");
    for (const key of tagKeys) {
      const t = issue.tags[key];
      out.push(`- ${key}: ${t.values.map((v) => `${v.value} (${Math.round((v.count / t.total) * 100)}%)`).join(", ")}`);
    }
  }
  return out.join("\n");
}

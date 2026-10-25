"use client";

import { ChevronDown, ChevronRight, Globe, MousePointerClick, Navigation, Terminal, TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { Breadcrumb, EventData, StoredEvent } from "@/lib/api";
import { cx } from "@/lib/format";
import { Exceptions } from "./stacktrace";
import { Card, CopyButton, LevelBadge } from "./ui";

export function EventView({ event }: { event: StoredEvent }) {
  const d = event.data;
  return (
    <div className="space-y-4">
      {d.exception?.values.length ? (
        <Card title="Exception">
          <div className="p-4">
            <Exceptions values={d.exception.values} />
          </div>
        </Card>
      ) : (
        <Card title="Message">
          <p className="whitespace-pre-wrap break-words p-4 font-mono text-sm text-ink">{d.message}</p>
        </Card>
      )}
      {d.breadcrumbs && d.breadcrumbs.length > 0 && <Breadcrumbs crumbs={d.breadcrumbs} eventTime={event.occurred_at} />}
      {d.request && <RequestCard request={d.request} />}
      <EventTags data={d} />
      {d.user && Object.keys(d.user).length > 0 && (
        <Card title="User">
          <KeyValues data={d.user} />
        </Card>
      )}
      {d.contexts && Object.keys(d.contexts).length > 0 && <Contexts contexts={d.contexts} />}
      {d.extra && Object.keys(d.extra).length > 0 && (
        <Card title="Additional data">
          <KeyValues data={d.extra} />
        </Card>
      )}
      <RawJson data={d} />
    </div>
  );
}

const CRUMB_ICON: Record<string, ReactNode> = {
  http: <Globe className="size-3.5" aria-hidden />,
  navigation: <Navigation className="size-3.5" aria-hidden />,
  ui: <MousePointerClick className="size-3.5" aria-hidden />,
  console: <Terminal className="size-3.5" aria-hidden />,
  error: <TriangleAlert className="size-3.5" aria-hidden />,
};

function crumbText(c: Breadcrumb): string {
  if (c.message) return c.message;
  const data = c.data ?? {};
  if (c.type === "http") return `${data.method ?? "GET"} ${data.url ?? ""} ${data.status_code ? `→ ${data.status_code}` : data.error ? `→ ${data.error}` : ""}`.trim();
  if (c.type === "navigation") return `${data.from ?? ""} → ${data.to ?? ""}`;
  return Object.keys(data).length ? JSON.stringify(data) : "";
}

function Breadcrumbs({ crumbs, eventTime }: { crumbs: Breadcrumb[]; eventTime: string }) {
  const [all, setAll] = useState(false);
  const ordered = [...crumbs].reverse();
  const shown = all ? ordered : ordered.slice(0, 15);
  const end = new Date(eventTime).getTime();
  return (
    <Card
      title={
        <span>
          Breadcrumbs <span className="font-normal text-muted">· what happened before, newest first</span>
        </span>
      }
    >
      <ul className="divide-y divide-line">
        {shown.map((c, i) => {
          const isProblem = c.level === "error" || c.level === "fatal" || c.level === "warning";
          const delta = (end - new Date(c.timestamp).getTime()) / 1000;
          return (
            <li key={i} className={cx("flex items-start gap-3 px-4 py-2 text-sm", isProblem && "bg-critical-wash")}>
              <span className="mt-0.5 text-muted">{CRUMB_ICON[c.type ?? ""] ?? <ChevronRight className="size-3.5" aria-hidden />}</span>
              <span className="w-24 shrink-0 truncate text-xs leading-5 text-ink-2">{c.category ?? c.type ?? "default"}</span>
              <span className="min-w-0 flex-1 break-words font-mono text-[12.5px] leading-5 text-ink">{crumbText(c)}</span>
              {c.level && c.level !== "info" && <LevelBadge level={c.level} />}
              <span className="tabular w-16 shrink-0 text-right text-xs leading-5 text-muted" title={c.timestamp}>
                {delta < 1 ? "<1s" : delta < 60 ? `-${Math.round(delta)}s` : delta < 3600 ? `-${Math.round(delta / 60)}m` : `-${Math.round(delta / 3600)}h`}
              </span>
            </li>
          );
        })}
      </ul>
      {ordered.length > 15 && (
        <button onClick={() => setAll((a) => !a)} className="w-full border-t border-line px-4 py-2 text-xs text-accent-ink hover:bg-surface-hover">
          {all ? "Show fewer" : `Show all ${ordered.length} breadcrumbs`}
        </button>
      )}
    </Card>
  );
}

function RequestCard({ request }: { request: NonNullable<EventData["request"]> }) {
  return (
    <Card title="Request">
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-2 font-mono text-sm">
          {request.method && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs font-semibold text-ink">{request.method}</span>}
          <span className="min-w-0 break-all text-ink">
            {request.url}
            {request.query_string ? <span className="text-ink-2">?{request.query_string}</span> : null}
          </span>
        </div>
        {request.headers && Object.keys(request.headers).length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs font-medium text-ink-2">Headers ({Object.keys(request.headers).length})</summary>
            <div className="mt-2">
              <KeyValues data={request.headers} bare />
            </div>
          </details>
        )}
        {request.data !== undefined && (
          <div>
            <div className="mb-1 text-xs font-medium text-ink-2">Body</div>
            <pre className="overflow-x-auto rounded-md bg-code p-3 font-mono text-[12.5px] text-ink">{typeof request.data === "string" ? request.data : JSON.stringify(request.data, null, 2)}</pre>
          </div>
        )}
      </div>
    </Card>
  );
}

function EventTags({ data }: { data: EventData }) {
  const tags: Record<string, string> = {};
  if (data.environment) tags.environment = data.environment;
  if (data.release) tags.release = data.release;
  if (data.transaction) tags.transaction = data.transaction;
  if (data.server_name) tags.server_name = data.server_name;
  if (data.level) tags.level = data.level;
  Object.assign(tags, data.tags);
  if (!Object.keys(tags).length) return null;
  return (
    <Card title="Tags">
      <div className="flex flex-wrap gap-1.5 p-4">
        {Object.entries(tags).map(([k, v]) => (
          <span key={k} className="inline-flex max-w-full overflow-hidden rounded-md border border-line text-xs">
            <span className="bg-surface-2 px-2 py-1 text-ink-2">{k}</span>
            <span className="truncate px-2 py-1 font-mono text-ink">{v}</span>
          </span>
        ))}
      </div>
    </Card>
  );
}

function Contexts({ contexts }: { contexts: Record<string, Record<string, unknown>> }) {
  return (
    <Card title="Contexts">
      <div className="grid gap-px bg-line sm:grid-cols-2">
        {Object.entries(contexts).map(([name, ctx]) => (
          <div key={name} className="bg-surface p-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{name}</h3>
            <KeyValues data={ctx} bare />
          </div>
        ))}
      </div>
    </Card>
  );
}

export function KeyValues({ data, bare }: { data: Record<string, unknown>; bare?: boolean }) {
  return (
    <dl className={cx("grid grid-cols-[minmax(80px,max-content)_1fr] gap-x-4 gap-y-1.5 text-sm", !bare && "p-4")}>
      {Object.entries(data).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="truncate text-ink-2">{k}</dt>
          <dd className="min-w-0 break-words font-mono text-[12.5px] text-ink">
            {typeof v === "string" && v.includes("\n") ? <pre className="whitespace-pre-wrap">{v}</pre> : typeof v === "object" ? JSON.stringify(v) : String(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function RawJson({ data }: { data: EventData }) {
  const [open, setOpen] = useState(false);
  const json = JSON.stringify(data, null, 2);
  return (
    <Card>
      <div className="flex items-center justify-between px-4 py-2.5">
        <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />} Raw event JSON
        </button>
        <CopyButton text={json} />
      </div>
      {open && <pre className="max-h-[600px] overflow-auto border-t border-line bg-code p-4 font-mono text-xs text-ink">{json}</pre>}
    </Card>
  );
}

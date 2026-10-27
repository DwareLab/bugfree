"use client";

import { ExternalLink, Inbox, MessageSquare, Search, Settings, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { type DragEvent, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader, useShell } from "@/components/app-shell";
import { Avatar, CommentForm, CommentThread, SEVERITIES, STATUSES, Select, SeverityBadge, StatusPill } from "@/components/tickets";
import { Button, EmptyState, ErrorBox, Input, Spinner } from "@/components/ui";
import { type Project, type Ticket, type TicketDetail, type TicketStatus, type User, api, useApi } from "@/lib/api";
import { cx, formatDate, timeAgo } from "@/lib/format";

export default function TicketsPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <Board />
    </Suspense>
  );
}

interface DropTarget {
  status: TicketStatus;
  index: number;
}

function Board() {
  const { projectId } = useParams<{ projectId: string }>();
  const { reloadProjects } = useShell();
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const project = useApi<Project>(`/api/projects/${projectId}`);
  const tickets = useApi<Ticket[]>(`/api/projects/${projectId}/tickets`, { refreshMs: 30_000 });
  const [filter, setFilter] = useState("");
  const [dragging, setDragging] = useState<number | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [moveError, setMoveError] = useState<Error | null>(null);
  const columnRefs = useRef(new Map<TicketStatus, HTMLDivElement>());

  const open = Number(search.get("ticket")) || null;
  const setOpen = (n: number | null) => {
    const next = new URLSearchParams(search.toString());
    if (n) next.set("ticket", String(n));
    else next.delete("ticket");
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  };

  const columns = useMemo(() => {
    const q = filter.trim().toLowerCase().replace(/^#/, "");
    const visible = (tickets.data ?? []).filter(
      (t) => !q || t.title.toLowerCase().includes(q) || String(t.number) === q || t.reporter?.login.toLowerCase().includes(q),
    );
    return STATUSES.map((s) => ({ ...s, tickets: visible.filter((t) => t.status === s.value).sort((a, b) => a.position - b.position) }));
  }, [tickets.data, filter]);

  /** Where in the column the pointer is: before the first card whose middle is below it. */
  function dragOver(e: DragEvent, status: TicketStatus) {
    if (dragging === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const cards = [...(columnRefs.current.get(status)?.querySelectorAll<HTMLElement>("[data-ticket]") ?? [])].filter(
      (el) => Number(el.dataset.ticket) !== dragging,
    );
    let index = cards.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    if (index === -1) index = cards.length;
    if (drop?.status !== status || drop.index !== index) setDrop({ status, index });
  }

  async function dropTicket(target: DropTarget) {
    const number = dragging;
    setDragging(null);
    setDrop(null);
    if (number === null) return;
    const ticket = tickets.data?.find((t) => t.number === number);
    if (!ticket) return;
    // The position is halfway between the new neighbours, so no other card has to move.
    const column = (tickets.data ?? []).filter((t) => t.status === target.status && t.number !== number).sort((a, b) => a.position - b.position);
    const before = column[target.index - 1];
    const after = column[target.index];
    const position = before && after ? (before.position + after.position) / 2 : before ? before.position + 1 : after ? after.position - 1 : 0;
    if (ticket.status === target.status && ticket.position === position) return;

    tickets.setData((prev) => (prev ?? []).map((t) => (t.number === number ? { ...t, status: target.status, position } : t)));
    setMoveError(null);
    try {
      await api(`/api/projects/${projectId}/tickets/${number}`, { method: "PATCH", json: { status: target.status, position } });
      if (ticket.status === "new" || target.status === "new") void reloadProjects();
    } catch (err) {
      setMoveError(err as Error);
      void tickets.reload();
    }
  }

  if (tickets.error) return <div className="p-6"><ErrorBox error={tickets.error} onRetry={tickets.reload} /></div>;
  if (!tickets.data || !project.data) return <Spinner />;
  const p = project.data;

  return (
    <>
      <PageHeader
        title={`${p.name} · Bug reports`}
        subtitle={
          p.portal_enabled && p.portal_url ? (
            <>
              People report bugs at{" "}
              <a href={p.portal_url} target="_blank" rel="noreferrer" className="text-accent-ink hover:underline">
                {p.portal_url.replace(/^https?:\/\//, "")}
              </a>
            </>
          ) : (
            "The bug report page is off. Turn it on in Settings to start collecting reports."
          )
        }
        actions={
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted" aria-hidden />
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by title, #, reporter" className="w-64 pl-8" aria-label="Filter tickets" />
            </div>
            {p.portal_enabled && p.portal_url ? (
              <a href={p.portal_url} target="_blank" rel="noreferrer">
                <Button>
                  <ExternalLink className="size-4" aria-hidden />
                  Open report page
                </Button>
              </a>
            ) : (
              <Link href={`/projects/${projectId}/settings#portal`}>
                <Button variant="primary">
                  <Settings className="size-4" aria-hidden />
                  Set up the report page
                </Button>
              </Link>
            )}
          </>
        }
      />
      {moveError && (
        <div className="px-4 pt-4 md:px-6">
          <ErrorBox error={moveError} />
        </div>
      )}
      {tickets.data.length === 0 ? (
        <EmptyState icon={<Inbox className="size-8" />} title="No bug reports yet">
          {p.portal_enabled
            ? "Share the report page with your users, or link to it from your app's help menu. New reports land in the New column."
            : "Turn on the bug report page in Settings, then share its link with your users."}
        </EmptyState>
      ) : (
        <div className="flex gap-3 overflow-x-auto p-4 md:px-6" onDragEnd={() => (setDragging(null), setDrop(null))}>
          {columns.map((col) => (
            <section
              key={col.value}
              aria-label={col.label}
              className={cx(
                "flex w-72 shrink-0 flex-col rounded-lg border bg-surface-2/60",
                drop?.status === col.value ? "border-accent" : "border-line",
              )}
              onDragOver={(e) => dragOver(e, col.value)}
              onDrop={(e) => {
                e.preventDefault();
                void dropTicket(drop ?? { status: col.value, index: col.tickets.length });
              }}
            >
              <header className="flex items-center gap-2 px-3 pt-2.5 pb-2">
                <span className={cx("size-2 rounded-full", col.dot)} aria-hidden />
                <h2 className="text-sm font-semibold text-ink">{col.label}</h2>
                <span className="tabular text-xs text-muted">{col.tickets.length}</span>
              </header>
              <div
                ref={(el) => {
                  if (el) columnRefs.current.set(col.value, el);
                }}
                className="flex min-h-24 flex-1 flex-col gap-2 px-2 pb-2"
              >
                {col.tickets.map((t) => {
                  const index = col.tickets.filter((x) => x.number !== dragging).indexOf(t);
                  return (
                    <div key={t.number}>
                      {drop?.status === col.value && index !== -1 && drop.index === index && <DropLine />}
                      <TicketCard ticket={t} dragging={t.number === dragging} onOpen={() => setOpen(t.number)} onDragStart={() => setDragging(t.number)} />
                    </div>
                  );
                })}
                {drop?.status === col.value && drop.index >= col.tickets.filter((t) => t.number !== dragging).length && <DropLine />}
                {!col.tickets.length && drop?.status !== col.value && <p className="px-1 py-3 text-center text-xs text-muted">Nothing here</p>}
              </div>
            </section>
          ))}
        </div>
      )}
      {open && (
        <TicketDrawer
          projectId={projectId}
          number={open}
          onClose={() => setOpen(null)}
          onChange={(t) => {
            tickets.setData((prev) => (prev ?? []).map((x) => (x.number === t.number ? { ...x, ...t } : x)));
            void reloadProjects();
          }}
          onDelete={() => {
            tickets.setData((prev) => (prev ?? []).filter((x) => x.number !== open));
            setOpen(null);
            void reloadProjects();
          }}
        />
      )}
    </>
  );
}

function DropLine() {
  return <div className="mb-2 h-0.5 rounded-full bg-accent" aria-hidden />;
}

function TicketCard({ ticket: t, dragging, onOpen, onDragStart }: { ticket: Ticket; dragging: boolean; onOpen: () => void; onDragStart: () => void }) {
  return (
    <button
      type="button"
      data-ticket={t.number}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(t.number));
        onDragStart();
      }}
      onClick={onOpen}
      className={cx(
        "w-full cursor-grab rounded-md border border-line bg-surface p-2.5 text-left shadow-xs transition-colors hover:border-accent/50 active:cursor-grabbing",
        dragging && "opacity-40",
      )}
    >
      <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted">
        <span className="tabular">#{t.number}</span>
        <SeverityBadge severity={t.severity} />
      </div>
      <p className="line-clamp-3 text-sm font-medium break-words text-ink">{t.title}</p>
      <div className="mt-2 flex items-center gap-2 text-xs text-muted">
        {t.reporter && (
          <span className="flex min-w-0 items-center gap-1">
            <Avatar src={t.reporter.avatar_url} name={t.reporter.login} size={16} />
            <span className="truncate">{t.reporter.login}</span>
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {t.comment_count > 0 && (
            <span className="flex items-center gap-0.5" title={`${t.comment_count} comments`}>
              <MessageSquare className="size-3" aria-hidden />
              {t.comment_count}
            </span>
          )}
          {t.assignee && <Avatar name={t.assignee.email} size={16} />}
          <span title={formatDate(t.created_at)}>{timeAgo(t.created_at)}</span>
        </span>
      </div>
    </button>
  );
}

function TicketDrawer({
  projectId,
  number,
  onClose,
  onChange,
  onDelete,
}: {
  projectId: string;
  number: number;
  onClose: () => void;
  onChange: (t: TicketDetail) => void;
  onDelete: () => void;
}) {
  const path = `/api/projects/${projectId}/tickets/${number}`;
  const ticket = useApi<TicketDetail>(path);
  const users = useApi<User[]>("/api/users");
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function update(patch: Record<string, unknown>) {
    setError(null);
    try {
      const t = await api<TicketDetail>(path, { method: "PATCH", json: patch });
      ticket.setData(t);
      onChange(t);
    } catch (err) {
      setError(err as Error);
    }
  }

  async function remove() {
    if (!confirm(`Delete bug report #${number}? The reporter will no longer see it either.`)) return;
    try {
      await api(path, { method: "DELETE" });
      onDelete();
    } catch (err) {
      setError(err as Error);
    }
  }

  const t = ticket.data;
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={`Bug report #${number}`}>
      <button className="absolute inset-0 bg-black/20" onClick={onClose} aria-label="Close" tabIndex={-1} />
      <div className="relative flex h-full w-full max-w-xl flex-col border-l border-line bg-page shadow-xl">
        <header className="flex items-center gap-2 border-b border-line bg-surface px-4 py-3">
          <span className="tabular text-sm text-muted">#{number}</span>
          {t && <StatusPill status={t.status} />}
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={remove} aria-label="Delete ticket">
              <Trash2 className="size-4" aria-hidden />
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
              <X className="size-4" aria-hidden />
            </Button>
          </div>
        </header>
        {ticket.error ? (
          <div className="p-4"><ErrorBox error={ticket.error} onRetry={ticket.reload} /></div>
        ) : !t ? (
          <Spinner />
        ) : (
          <div className="flex-1 space-y-5 overflow-y-auto p-4">
            <div>
              <h2 className="text-lg font-semibold break-words text-ink">{t.title}</h2>
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-ink-2">
                {t.reporter ? (
                  <>
                    <Avatar src={t.reporter.avatar_url} name={t.reporter.login} size={18} />
                    <a href={`https://github.com/${t.reporter.login}`} target="_blank" rel="noreferrer" className="font-medium text-ink hover:underline">
                      {t.reporter.login}
                    </a>
                  </>
                ) : (
                  "A deleted reporter"
                )}
                <span>reported {timeAgo(t.created_at)}</span>
              </p>
            </div>

            {error && <ErrorBox error={error} />}

            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted">Status</dt>
              <dd>
                <Select label="Status" value={t.status} options={STATUSES} onChange={(status) => update({ status })} />
              </dd>
              <dt className="text-muted">Severity</dt>
              <dd>
                <Select label="Severity" value={t.severity} options={SEVERITIES} onChange={(severity) => update({ severity })} />
              </dd>
              <dt className="text-muted">Assignee</dt>
              <dd>
                <Select
                  label="Assignee"
                  value={t.assignee ? String(t.assignee.id) : ""}
                  options={[{ value: "", label: "Unassigned" }, ...(users.data ?? []).map((u) => ({ value: String(u.id), label: u.email }))]}
                  onChange={(id) => update({ assignee_id: id ? Number(id) : null })}
                  className="max-w-full"
                />
              </dd>
              {t.page_url && (
                <>
                  <dt className="text-muted">Page</dt>
                  <dd className="min-w-0 truncate">
                    <a href={t.page_url} target="_blank" rel="noreferrer noopener" className="text-accent-ink hover:underline">
                      {t.page_url}
                    </a>
                  </dd>
                </>
              )}
              {t.user_agent && (
                <>
                  <dt className="text-muted">Browser</dt>
                  <dd className="min-w-0 truncate font-mono text-xs text-ink-2" title={t.user_agent}>
                    {t.user_agent}
                  </dd>
                </>
              )}
            </dl>

            <section>
              <h3 className="mb-1.5 text-sm font-semibold text-ink">What happened</h3>
              <p className="rounded-lg border border-line bg-surface px-3 py-2.5 text-sm whitespace-pre-wrap break-words text-ink">{t.description}</p>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-ink">Conversation</h3>
              <CommentThread comments={t.comments} empty="No replies yet. Replies are shown to the reporter; internal notes aren't." />
              <CommentForm
                allowInternal
                placeholder={`Reply to ${t.reporter?.login ?? "the reporter"}`}
                onSubmit={async (body, internal) => {
                  const updated = await api<TicketDetail>(`${path}/comments`, { method: "POST", json: { body, internal } });
                  ticket.setData(updated);
                  onChange(updated);
                }}
              />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

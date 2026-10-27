"use client";

import { ExternalLink, Inbox, MessageSquare, Search, Split, Trash2, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type DragEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { type Ticket, type TicketDetail, type TicketStatus, type User, api, useApi } from "@/lib/api";
import { cx, formatDate, timeAgo } from "@/lib/format";
import { useShell } from "./app-shell";
import { Avatar, CommentForm, CommentThread, SEVERITIES, STATUSES, Select, SeverityBadge, StatusPill } from "./tickets";
import { EmptyState, ErrorBox, Input, Spinner, Button } from "./ui";

/**
 * A Kanban board of bug reports. A project's board has the reports routed to it; a report page's board has
 * everything filed on that page, can be filtered by project, and shows what still needs routing.
 */
export type BoardScope = { projectId: number } | { portalId: number; projects: Array<{ id: number; name: string }> };

/** Filter value on a report page's board: everything, the unrouted ones, or one project's. */
type ProjectFilter = "all" | "unrouted" | `${number}`;

interface DropTarget {
  status: TicketStatus;
  index: number;
}

export function TicketBoard({ scope, empty }: { scope: BoardScope; empty: ReactNode }) {
  const { reloadCounts } = useShell();
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const path = "projectId" in scope ? `/api/tickets?project_id=${scope.projectId}` : `/api/tickets?portal_id=${scope.portalId}`;
  const tickets = useApi<Ticket[]>(path, { refreshMs: 30_000 });
  const [filter, setFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>("all");
  const [dragging, setDragging] = useState<number | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [moveError, setMoveError] = useState<Error | null>(null);
  const columnRefs = useRef(new Map<TicketStatus, HTMLDivElement>());

  const open = Number(search.get("ticket")) || null;
  const setOpen = (id: number | null) => {
    const next = new URLSearchParams(search.toString());
    if (id) next.set("ticket", String(id));
    else next.delete("ticket");
    router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
  };

  const unrouted = (tickets.data ?? []).filter((t) => !t.project && t.status !== "done" && t.status !== "wont_fix").length;
  const columns = useMemo(() => {
    const q = filter.trim().toLowerCase().replace(/^#/, "");
    const visible = (tickets.data ?? []).filter(
      (t) =>
        (projectFilter === "all" || (projectFilter === "unrouted" ? !t.project : t.project?.id === Number(projectFilter))) &&
        (!q || t.title.toLowerCase().includes(q) || String(t.id) === q || t.reporter?.login.toLowerCase().includes(q)),
    );
    return STATUSES.map((s) => ({ ...s, tickets: visible.filter((t) => t.status === s.value).sort((a, b) => a.position - b.position) }));
  }, [tickets.data, filter, projectFilter]);

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
    const id = dragging;
    setDragging(null);
    setDrop(null);
    if (id === null) return;
    const ticket = tickets.data?.find((t) => t.id === id);
    if (!ticket) return;
    // The position is halfway between the new neighbours as shown, so no other card has to move.
    const column = columns.find((c) => c.value === target.status)!.tickets.filter((t) => t.id !== id);
    const before = column[target.index - 1];
    const after = column[target.index];
    const position = before && after ? (before.position + after.position) / 2 : before ? before.position + 1 : after ? after.position - 1 : 0;
    if (ticket.status === target.status && ticket.position === position) return;

    tickets.setData((prev) => (prev ?? []).map((t) => (t.id === id ? { ...t, status: target.status, position } : t)));
    setMoveError(null);
    try {
      await api(`/api/tickets/${id}`, { method: "PATCH", json: { status: target.status, position } });
      if (ticket.status === "new" || target.status === "new") void reloadCounts();
    } catch (err) {
      setMoveError(err as Error);
      void tickets.reload();
    }
  }

  if (tickets.error) return <div className="p-6"><ErrorBox error={tickets.error} onRetry={tickets.reload} /></div>;
  if (!tickets.data) return <Spinner />;
  const onPortalBoard = "portalId" in scope;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-4 pt-4 md:px-6">
        <div className="relative">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted" aria-hidden />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by title, #, reporter" className="w-64 pl-8" aria-label="Filter reports" />
        </div>
        {onPortalBoard && scope.projects.length > 1 && (
          <Select<ProjectFilter>
            label="Project"
            value={projectFilter}
            onChange={setProjectFilter}
            className="h-9"
            options={[
              { value: "all", label: "All projects" },
              { value: "unrouted", label: `Needs routing (${unrouted})` },
              ...scope.projects.map((p) => ({ value: `${p.id}` as const, label: p.name })),
            ]}
          />
        )}
        {onPortalBoard && unrouted > 0 && projectFilter === "all" && (
          <button
            onClick={() => setProjectFilter("unrouted")}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-sm text-ink hover:bg-surface-hover"
          >
            <Split className="size-4 text-serious" aria-hidden />
            {unrouted} {unrouted === 1 ? "report needs" : "reports need"} routing
          </button>
        )}
      </div>
      {moveError && (
        <div className="px-4 pt-4 md:px-6">
          <ErrorBox error={moveError} />
        </div>
      )}
      {tickets.data.length === 0 ? (
        <EmptyState icon={<Inbox className="size-8" />} title="No bug reports yet">
          {empty}
        </EmptyState>
      ) : (
        <div className="flex gap-3 overflow-x-auto p-4 md:px-6" onDragEnd={() => (setDragging(null), setDrop(null))}>
          {columns.map((col) => (
            <section
              key={col.value}
              aria-label={col.label}
              className={cx("flex w-72 shrink-0 flex-col rounded-lg border bg-surface-2/60", drop?.status === col.value ? "border-accent" : "border-line")}
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
                  const index = col.tickets.filter((x) => x.id !== dragging).indexOf(t);
                  return (
                    <div key={t.id}>
                      {drop?.status === col.value && index !== -1 && drop.index === index && <DropLine />}
                      <TicketCard
                        ticket={t}
                        showProject={onPortalBoard}
                        dragging={t.id === dragging}
                        onOpen={() => setOpen(t.id)}
                        onDragStart={() => setDragging(t.id)}
                      />
                    </div>
                  );
                })}
                {drop?.status === col.value && drop.index >= col.tickets.filter((t) => t.id !== dragging).length && <DropLine />}
                {!col.tickets.length && drop?.status !== col.value && <p className="px-1 py-3 text-center text-xs text-muted">Nothing here</p>}
              </div>
            </section>
          ))}
        </div>
      )}
      {open && (
        <TicketDrawer
          id={open}
          onClose={() => setOpen(null)}
          onChange={(t) => {
            // Routed away from this project: it's no longer on this board.
            const leftBoard = "projectId" in scope && t.project?.id !== scope.projectId;
            tickets.setData((prev) => (leftBoard ? (prev ?? []).filter((x) => x.id !== t.id) : (prev ?? []).map((x) => (x.id === t.id ? { ...x, ...t } : x))));
            if (leftBoard) setOpen(null);
            void reloadCounts();
          }}
          onDelete={() => {
            tickets.setData((prev) => (prev ?? []).filter((x) => x.id !== open));
            setOpen(null);
            void reloadCounts();
          }}
        />
      )}
    </>
  );
}

function DropLine() {
  return <div className="mb-2 h-0.5 rounded-full bg-accent" aria-hidden />;
}

function TicketCard({
  ticket: t,
  showProject,
  dragging,
  onOpen,
  onDragStart,
}: {
  ticket: Ticket;
  showProject: boolean;
  dragging: boolean;
  onOpen: () => void;
  onDragStart: () => void;
}) {
  return (
    <button
      type="button"
      data-ticket={t.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(t.id));
        onDragStart();
      }}
      onClick={onOpen}
      className={cx(
        "w-full cursor-grab rounded-md border border-line bg-surface p-2.5 text-left shadow-xs transition-colors hover:border-accent/50 active:cursor-grabbing",
        dragging && "opacity-40",
      )}
    >
      <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted">
        <span className="tabular">#{t.id}</span>
        <SeverityBadge severity={t.severity} />
      </div>
      <p className="line-clamp-3 text-sm font-medium break-words text-ink">{t.title}</p>
      {showProject && <ProjectChip project={t.project} />}
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

function ProjectChip({ project }: { project: Ticket["project"] }) {
  return (
    <span
      className={cx(
        "mt-1.5 inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
        project ? "bg-surface-2 text-ink-2" : "border border-dashed border-serious/60 text-ink",
      )}
    >
      {!project && <Split className="size-3 shrink-0 text-serious" aria-hidden />}
      <span className="truncate">{project ? project.name : "Needs routing"}</span>
    </span>
  );
}

function TicketDrawer({ id, onClose, onChange, onDelete }: { id: number; onClose: () => void; onChange: (t: TicketDetail) => void; onDelete: () => void }) {
  const { projects } = useShell();
  const path = `/api/tickets/${id}`;
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
    if (!confirm(`Delete bug report #${id}? The reporter will no longer see it either.`)) return;
    try {
      await api(path, { method: "DELETE" });
      onDelete();
    } catch (err) {
      setError(err as Error);
    }
  }

  const t = ticket.data;
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={`Bug report #${id}`}>
      <button className="absolute inset-0 bg-black/20" onClick={onClose} aria-label="Close" tabIndex={-1} />
      <div className="relative flex h-full w-full max-w-xl flex-col border-l border-line bg-page shadow-xl">
        <header className="flex items-center gap-2 border-b border-line bg-surface px-4 py-3">
          <span className="tabular text-sm text-muted">#{id}</span>
          {t && <StatusPill status={t.status} />}
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={remove} aria-label="Delete report">
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
                {t.portal && (
                  <span>
                    on{" "}
                    <Link href={`/portals/${t.portal.id}`} className="text-accent-ink hover:underline">
                      {t.portal.name}
                    </Link>
                  </span>
                )}
              </p>
            </div>

            {error && <ErrorBox error={error} />}

            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted">Project</dt>
              <dd className="flex min-w-0 items-center gap-2">
                <Select
                  label="Project"
                  value={t.project ? String(t.project.id) : ""}
                  options={[
                    ...(t.project && !t.portal ? [] : [{ value: "", label: "Needs routing" }]),
                    ...projects.map((p) => ({ value: String(p.id), label: p.name })),
                  ]}
                  onChange={(projectId) => update({ project_id: projectId ? Number(projectId) : null })}
                  className={cx("max-w-full", !t.project && "border-serious")}
                />
                {t.project && (
                  <Link href={`/projects/${t.project.id}/tickets?ticket=${t.id}`} className="text-muted hover:text-ink" aria-label={`Open on the ${t.project.name} board`}>
                    <ExternalLink className="size-3.5" aria-hidden />
                  </Link>
                )}
              </dd>
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
                  onChange={(assignee) => update({ assignee_id: assignee ? Number(assignee) : null })}
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

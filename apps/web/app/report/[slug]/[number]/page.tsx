"use client";

import { ArrowLeft, Check, CircleCheck } from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { usePortal } from "@/components/portal-shell";
import { CommentForm, CommentThread, STATUSES, SeverityBadge, StatusPill } from "@/components/tickets";
import { Card, EmptyState, ErrorBox, Spinner } from "@/components/ui";
import { ApiError, type ReporterTicketDetail, type TicketStatus, api, useApi } from "@/lib/api";
import { cx, formatDate, timeAgo } from "@/lib/format";

export default function PortalTicket() {
  const { slug, project } = usePortal();
  const { number } = useParams<{ number: string }>();
  const sent = useSearchParams().get("sent") === "1";
  const path = `/api/portal/${encodeURIComponent(slug)}/tickets/${encodeURIComponent(number)}`;
  const ticket = useApi<ReporterTicketDetail>(path, { refreshMs: 60_000 });

  const back = (
    <Link href={`/report/${slug}`} className="mb-4 inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink">
      <ArrowLeft className="size-4" aria-hidden />
      All your reports
    </Link>
  );

  if (ticket.error) {
    return (
      <>
        {back}
        {ticket.error instanceof ApiError && ticket.error.status === 404 ? (
          <EmptyState title="Report not found">It may have been removed, or it was filed from another account.</EmptyState>
        ) : (
          <ErrorBox error={ticket.error} onRetry={ticket.reload} />
        )}
      </>
    );
  }
  if (!ticket.data) return <Spinner />;
  const t = ticket.data;

  return (
    <div className="mx-auto max-w-3xl">
      {back}
      {sent && (
        <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-line bg-accent-wash px-4 py-3 text-sm text-ink" role="status">
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-accent-ink" aria-hidden />
          <div>
            <strong className="font-medium">Thanks, your report was sent.</strong> The {project.name} team will see it right away. Check back here for
            their replies and progress.
          </div>
        </div>
      )}
      <div className="space-y-5">
        <div>
          <div className="mb-1.5 flex flex-wrap items-center gap-2 text-sm text-muted">
            <span className="tabular">#{t.number}</span>
            <StatusPill status={t.status} audience="portal" />
            <SeverityBadge severity={t.severity} />
          </div>
          <h1 className="text-xl font-semibold tracking-tight break-words text-ink">{t.title}</h1>
          <p className="mt-1 text-sm text-muted" title={formatDate(t.created_at)}>
            Reported {timeAgo(t.created_at)}
          </p>
        </div>

        <Progress status={t.status} />

        <Card title="What you reported">
          <div className="space-y-2 p-4">
            <p className="text-sm whitespace-pre-wrap break-words text-ink">{t.description}</p>
            {t.page_url && (
              <p className="truncate text-sm text-ink-2">
                Page:{" "}
                <a href={t.page_url} target="_blank" rel="noreferrer noopener" className="text-accent-ink hover:underline">
                  {t.page_url}
                </a>
              </p>
            )}
          </div>
        </Card>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-ink">Conversation</h2>
          <CommentThread comments={t.comments} empty="No replies yet. You'll see the team's answer here." />
          <CommentForm
            placeholder="Add more details or answer the team's questions"
            onSubmit={async (body) => ticket.setData(await api<ReporterTicketDetail>(`${path}/comments`, { method: "POST", json: { body } }))}
          />
        </section>
      </div>
    </div>
  );
}

/** Received → Planned → Being worked on → Fixed, or Closed when the team won't fix it. */
function Progress({ status }: { status: TicketStatus }) {
  if (status === "wont_fix") {
    return (
      <p className="rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm text-ink-2">
        The team closed this report without a change. If you think that&apos;s a mistake, reply below.
      </p>
    );
  }
  const steps = STATUSES.filter((s) => s.value !== "wont_fix");
  const current = steps.findIndex((s) => s.value === status);
  return (
    <ol className="grid grid-cols-4 gap-2" aria-label="Progress">
      {steps.map((s, i) => (
        <li key={s.value} aria-current={i === current ? "step" : undefined} className="min-w-0">
          <div className={cx("h-1.5 rounded-full", i <= current ? "bg-accent" : "bg-surface-2")} />
          <div className={cx("mt-1.5 flex items-center gap-1 text-xs", i === current ? "font-medium text-ink" : i < current ? "text-ink-2" : "text-muted")}>
            {i < current && <Check className="size-3 shrink-0" aria-hidden />}
            <span className="truncate">{s.portal}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

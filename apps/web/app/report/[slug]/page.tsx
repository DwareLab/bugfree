"use client";

import { ChevronRight, MessageSquare } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useState } from "react";
import { usePortal } from "@/components/portal-shell";
import { SEVERITIES, StatusPill, Textarea } from "@/components/tickets";
import { Button, Card, ErrorBox, Input, Label } from "@/components/ui";
import { type ReporterTicket, type ReporterTicketDetail, type Severity, api, useApi } from "@/lib/api";
import { cx, formatDate, timeAgo } from "@/lib/format";

export default function PortalHome() {
  const { slug } = usePortal();
  const tickets = useApi<ReporterTicket[]>(`/api/portal/${encodeURIComponent(slug)}/tickets`);

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_20rem]">
      <ReportForm />
      <Card title="Your reports" className="self-start">
        {tickets.error ? (
          <div className="p-3">
            <ErrorBox error={tickets.error} onRetry={tickets.reload} />
          </div>
        ) : !tickets.data ? (
          <p className="px-4 py-6 text-sm text-muted">Loading…</p>
        ) : !tickets.data.length ? (
          <p className="px-4 py-6 text-sm text-ink-2">Nothing yet. Reports you send show up here, with the team&apos;s replies.</p>
        ) : (
          <ul className="divide-y divide-line">
            {tickets.data.map((t) => (
              <li key={t.number}>
                <Link href={`/report/${slug}/${t.number}`} className="flex items-center gap-2 px-4 py-3 hover:bg-surface-hover">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{t.title}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                      <StatusPill status={t.status} audience="portal" />
                      <span title={formatDate(t.updated_at)}>updated {timeAgo(t.updated_at)}</span>
                      {t.comment_count > 0 && (
                        <span className="flex items-center gap-0.5">
                          <MessageSquare className="size-3" aria-hidden />
                          {t.comment_count}
                        </span>
                      )}
                    </div>
                  </div>
                  <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function ReportForm() {
  const { slug, project } = usePortal();
  const router = useRouter();
  const prefillUrl = useSearchParams().get("url") ?? "";
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [pageUrl, setPageUrl] = useState(/^https?:\/\//.test(prefillUrl) ? prefillUrl : "");
  const [severity, setSeverity] = useState<Severity>("normal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const ticket = await api<ReporterTicketDetail>(`/api/portal/${encodeURIComponent(slug)}/tickets`, {
        method: "POST",
        json: { title, description, page_url: pageUrl.trim(), severity },
      });
      router.push(`/report/${slug}/${ticket.number}?sent=1`);
    } catch (err) {
      setError(err as Error);
      setBusy(false);
    }
  }

  return (
    <Card title={`Report a bug in ${project.name}`}>
      <form onSubmit={submit} className="space-y-4 p-4">
        {error && <ErrorBox error={error} />}
        <div>
          <Label htmlFor="title" hint="A short summary, like “Checkout button does nothing”.">
            What went wrong?
          </Label>
          <Input id="title" required minLength={3} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="description" hint="What did you do, what did you expect, and what happened instead?">
            Details
          </Label>
          <Textarea
            id="description"
            required
            rows={7}
            maxLength={10_000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={"1. I went to …\n2. I clicked …\n\nI expected …, but instead …"}
          />
        </div>
        <div>
          <Label htmlFor="page_url" hint="Optional: the address of the page where it happened.">
            Page
          </Label>
          <Input id="page_url" type="url" placeholder="https://" value={pageUrl} onChange={(e) => setPageUrl(e.target.value)} />
        </div>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-ink">How bad is it?</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {SEVERITIES.map((s) => (
              <label
                key={s.value}
                className={cx(
                  "flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm",
                  severity === s.value ? "border-accent bg-accent-wash" : "border-line bg-surface hover:bg-surface-hover",
                )}
              >
                <input
                  type="radio"
                  name="severity"
                  value={s.value}
                  checked={severity === s.value}
                  onChange={() => setSeverity(s.value)}
                  className="mt-0.5 accent-[var(--accent)]"
                />
                <span>
                  <span className="block font-medium text-ink">{s.label}</span>
                  <span className="block text-xs text-ink-2">{s.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <Button type="submit" variant="primary" loading={busy}>
          Send report
        </Button>
      </form>
    </Card>
  );
}

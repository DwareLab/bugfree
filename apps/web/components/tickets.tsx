"use client";

import { Lock, MessageSquare } from "lucide-react";
import { type FormEvent, type ReactNode, type TextareaHTMLAttributes, useState } from "react";
import type { Severity, TicketComment, TicketStatus } from "@/lib/api";
import { cx, formatDate, timeAgo } from "@/lib/format";
import { Button, ErrorBox } from "./ui";

/** Board columns in order. `portal` is how the status reads to the person who reported the bug. */
export const STATUSES: Array<{ value: TicketStatus; label: string; portal: string; dot: string }> = [
  { value: "new", label: "New", portal: "Received", dot: "bg-accent" },
  { value: "todo", label: "To do", portal: "Planned", dot: "bg-muted" },
  { value: "in_progress", label: "In progress", portal: "Being worked on", dot: "bg-warning" },
  { value: "done", label: "Done", portal: "Fixed", dot: "bg-good" },
  { value: "wont_fix", label: "Won't fix", portal: "Closed", dot: "bg-ink-2" },
];

export const SEVERITIES: Array<{ value: Severity; label: string; hint: string; dot: string }> = [
  { value: "low", label: "Low", hint: "Cosmetic, or a small annoyance", dot: "bg-muted" },
  { value: "normal", label: "Normal", hint: "Something doesn't work as it should", dot: "bg-accent" },
  { value: "high", label: "High", hint: "I can't do something important", dot: "bg-serious" },
  { value: "critical", label: "Critical", hint: "Nothing works, or data was lost", dot: "bg-critical" },
];

const statusMeta = (s: TicketStatus) => STATUSES.find((x) => x.value === s) ?? STATUSES[0];
const severityMeta = (s: Severity) => SEVERITIES.find((x) => x.value === s) ?? SEVERITIES[1];

/** Status is never color alone: the dot always sits next to its name. */
export function StatusPill({ status, audience = "team" }: { status: TicketStatus; audience?: "team" | "portal" }) {
  const meta = statusMeta(status);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2 py-0.5 text-xs font-medium text-ink">
      <span className={cx("size-2 rounded-full", meta.dot)} aria-hidden />
      {audience === "portal" ? meta.portal : meta.label}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  const meta = severityMeta(severity);
  return (
    <span className="inline-flex items-center gap-1 text-xs text-ink-2" title={`Severity: ${meta.label}`}>
      <span className={cx("inline-block h-3 w-1 rounded-sm", meta.dot)} aria-hidden />
      {meta.label}
    </span>
  );
}

export function Avatar({ src, name, size = 20 }: { src?: string | null; name: string; size?: number }) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" width={size} height={size} className="shrink-0 rounded-full bg-surface-2" style={{ width: size, height: size }} />;
  }
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-surface-2 font-semibold text-ink-2 uppercase"
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.45) }}
    >
      {name.slice(0, 1)}
    </span>
  );
}

/** The conversation on a ticket. Internal notes (dashboard only) are marked and tinted. */
export function CommentThread({ comments, empty }: { comments: TicketComment[]; empty: ReactNode }) {
  if (!comments.length) {
    return (
      <p className="flex items-center gap-2 py-2 text-sm text-muted">
        <MessageSquare className="size-4" aria-hidden />
        {empty}
      </p>
    );
  }
  return (
    <ol className="space-y-3">
      {comments.map((c) => {
        const name = c.author_name ?? (c.author_kind === "team" ? "Former team member" : "Deleted user");
        return (
          <li key={c.id} className={cx("rounded-lg border border-line px-3 py-2.5", c.internal ? "bg-warning/10" : "bg-surface")}>
            <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <Avatar src={c.author_avatar} name={name} size={18} />
              <span className="font-medium text-ink">{name}</span>
              {c.author_kind === "team" && <span className="rounded bg-surface-2 px-1.5 py-px text-[11px] text-ink-2">Team</span>}
              {c.internal && (
                <span className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-px text-[11px] text-ink-2">
                  <Lock className="size-3" aria-hidden />
                  Internal note
                </span>
              )}
              <span className="text-muted" title={formatDate(c.created_at)}>
                {timeAgo(c.created_at)}
              </span>
            </div>
            <p className="text-sm whitespace-pre-wrap break-words text-ink">{c.body}</p>
          </li>
        );
      })}
    </ol>
  );
}

export function CommentForm({
  onSubmit,
  placeholder,
  allowInternal,
}: {
  onSubmit: (body: string, internal: boolean) => Promise<void>;
  placeholder: string;
  allowInternal?: boolean;
}) {
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(body, internal);
      setBody("");
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      {error && <ErrorBox error={error} />}
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={internal ? "Only your team sees internal notes" : placeholder}
        rows={3}
        aria-label="Comment"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(e);
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        {allowInternal ? (
          <label className="inline-flex items-center gap-1.5 text-xs text-ink-2">
            <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} className="accent-[var(--accent)]" />
            Internal note (hidden from the reporter)
          </label>
        ) : (
          <span />
        )}
        <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!body.trim()}>
          {internal ? "Add note" : "Send reply"}
        </Button>
      </div>
    </form>
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...rest}
      className={cx(
        "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-wash",
        className,
      )}
    />
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={cx("h-8 rounded-md border border-line bg-surface px-2 text-sm text-ink focus:border-accent focus:outline-none", className)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

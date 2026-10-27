import nodemailer, { type Transporter } from "nodemailer";
import { config } from "./config";
import { one, query } from "./db";

export type AlertKind = "new" | "regression";

const ALERT_COOLDOWN_MINUTES = 30;
let mailer: Transporter | null | undefined;

function getMailer(): Transporter | null {
  if (mailer === undefined) mailer = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : null;
  return mailer;
}

interface AlertRow {
  issue_id: number;
  title: string;
  culprit: string | null;
  level: string;
  times_seen: number;
  last_release: string | null;
  project_name: string;
  alert_webhook_url: string | null;
  alert_emails: string | null;
  alert_on_new: boolean;
  alert_on_regression: boolean;
}

/** Notifies the project's webhook / email recipients, at most once per issue per cooldown window. */
export async function sendIssueAlert(projectId: number, issueId: number, kind: AlertKind): Promise<void> {
  const project = await one<{ alert_on_new: boolean; alert_on_regression: boolean; alert_webhook_url: string | null; alert_emails: string | null }>(
    `SELECT alert_on_new, alert_on_regression, alert_webhook_url, alert_emails FROM projects WHERE id = $1`,
    [projectId],
  );
  if (!project) return;
  if ((kind === "new" && !project.alert_on_new) || (kind === "regression" && !project.alert_on_regression)) return;
  if (!project.alert_webhook_url && !(project.alert_emails && getMailer())) return;

  // Claim the alert atomically so concurrent events for one issue only notify once.
  const claimed = await query<AlertRow>(
    `UPDATE issues i SET last_alert_at = now()
     FROM projects p
     WHERE i.id = $1 AND p.id = i.project_id
       AND (i.last_alert_at IS NULL OR i.last_alert_at < now() - make_interval(mins => $2))
     RETURNING i.id AS issue_id, i.title, i.culprit, i.level, i.times_seen, i.last_release,
               p.name AS project_name, p.alert_webhook_url, p.alert_emails, p.alert_on_new, p.alert_on_regression`,
    [issueId, ALERT_COOLDOWN_MINUTES],
  );
  const row = claimed[0];
  if (!row) return;

  const link = `${config.appUrls[0]}/issues/${row.issue_id}`;
  const heading = kind === "new" ? "New issue" : "Regression";
  const text = `*[${row.project_name}] ${heading}:* ${row.title}\n${row.culprit ? `${row.culprit}\n` : ""}${row.last_release ? `Release: ${row.last_release}\n` : ""}${link}`;

  const jobs: Promise<unknown>[] = [];
  if (row.alert_webhook_url) jobs.push(postWebhook(row.alert_webhook_url, text, row, kind, link));
  const recipients = (row.alert_emails ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const transport = getMailer();
  if (recipients.length && transport) {
    jobs.push(
      transport.sendMail({
        from: config.alertFrom,
        to: recipients,
        subject: `[${row.project_name}] ${heading}: ${row.title}`.slice(0, 200),
        text: `${heading} in ${row.project_name}\n\n${row.title}\n${row.culprit ?? ""}\n\nLevel: ${row.level}\nRelease: ${row.last_release ?? "-"}\n\n${link}\n`,
      }),
    );
  }
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === "rejected") console.error("[alerts] delivery failed:", r.reason);
}

/** Slack-compatible payload (`text`); Discord reads `content`. Other services get the structured `issue`. */
async function postWebhook(url: string, text: string, row: AlertRow, kind: AlertKind, link: string): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text,
      content: text.replace(/\*/g, "**"),
      kind,
      issue: { id: row.issue_id, title: row.title, culprit: row.culprit, level: row.level, project: row.project_name, release: row.last_release, url: link },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
}

/** Sends a sample alert so users can verify their settings. */
export async function sendTestAlert(projectId: number): Promise<{ webhook?: string; email?: string }> {
  const p = await one<{ name: string; alert_webhook_url: string | null; alert_emails: string | null }>(
    `SELECT name, alert_webhook_url, alert_emails FROM projects WHERE id = $1`,
    [projectId],
  );
  if (!p) throw new Error("project not found");
  const out: { webhook?: string; email?: string } = {};
  const text = `*[${p.name}] Test alert* from bugfree — alerts are working.`;
  if (p.alert_webhook_url) {
    try {
      const res = await fetch(p.alert_webhook_url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, content: text.replace(/\*/g, "**"), kind: "test" }),
        signal: AbortSignal.timeout(10_000),
      });
      out.webhook = res.ok ? "sent" : `failed: HTTP ${res.status}`;
    } catch (err) {
      out.webhook = `failed: ${String(err)}`;
    }
  }
  const recipients = (p.alert_emails ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (recipients.length) {
    const transport = getMailer();
    if (!transport) out.email = "skipped: SMTP_URL is not configured on the API";
    else {
      try {
        await transport.sendMail({ from: config.alertFrom, to: recipients, subject: `[${p.name}] Test alert`, text: "Alerts from bugfree are working." });
        out.email = "sent";
      } catch (err) {
        out.email = `failed: ${String(err)}`;
      }
    }
  }
  return out;
}

/** Tells the project's webhook / email recipients about a new bug report from the portal. */
export async function sendTicketAlert(projectId: number, ticket: { number: number; title: string; severity: string; reporter: string }): Promise<void> {
  const p = await one<{ name: string; alert_webhook_url: string | null; alert_emails: string | null }>(
    `SELECT name, alert_webhook_url, alert_emails FROM projects WHERE id = $1`,
    [projectId],
  );
  if (!p) return;
  const link = `${config.appUrls[0]}/projects/${projectId}/tickets?ticket=${ticket.number}`;
  const text = `*[${p.name}] Bug report #${ticket.number}:* ${ticket.title}\nFrom @${ticket.reporter} · severity ${ticket.severity}\n${link}`;
  const jobs: Promise<unknown>[] = [];
  if (p.alert_webhook_url) {
    jobs.push(
      fetch(p.alert_webhook_url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          content: text.replace(/\*/g, "**"),
          kind: "ticket",
          ticket: { number: ticket.number, title: ticket.title, severity: ticket.severity, reporter: ticket.reporter, project: p.name, url: link },
        }),
        signal: AbortSignal.timeout(10_000),
      }).then((res) => {
        if (!res.ok) throw new Error(`webhook responded ${res.status}`);
      }),
    );
  }
  const recipients = (p.alert_emails ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const transport = getMailer();
  if (recipients.length && transport) {
    jobs.push(
      transport.sendMail({
        from: config.alertFrom,
        to: recipients,
        subject: `[${p.name}] Bug report #${ticket.number}: ${ticket.title}`.slice(0, 200),
        text: `New bug report in ${p.name} from @${ticket.reporter}\n\n#${ticket.number} ${ticket.title}\nSeverity: ${ticket.severity}\n\n${link}\n`,
      }),
    );
  }
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === "rejected") console.error("[alerts] ticket alert failed:", r.reason);
}

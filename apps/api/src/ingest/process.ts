import type pg from "pg";
import { transaction } from "../db";
import { type AlertKind, sendIssueAlert } from "../alerts";
import { finalizeInApp, fingerprint, summarize } from "./grouping";
import type { IncomingEvent } from "./schema";
import { Symbolicator } from "./symbolicate";

export const symbolicator = new Symbolicator();

const MAX_TAGS = 25;
const SKEW_MS = 5 * 60_000;

export interface ProcessResult {
  issueId: number;
  eventId: string;
  isNew: boolean;
  isRegression: boolean;
  duplicate: boolean;
}

/** Symbolicates, groups and stores one event, then fires alerts for new or regressed issues. */
export async function processEvent(projectId: number, event: IncomingEvent, clientIp?: string): Promise<ProcessResult> {
  for (const exc of event.exception?.values ?? []) {
    if (!exc.stacktrace) continue;
    exc.stacktrace.frames = await symbolicator.symbolicate(projectId, event.release, exc.stacktrace.frames);
    finalizeInApp(exc.stacktrace.frames);
  }

  const now = new Date();
  // Trust the client clock only within a few minutes of ours.
  const sent = event.timestamp ? new Date(event.timestamp) : now;
  const occurredAt = Number.isNaN(sent.getTime()) || Math.abs(sent.getTime() - now.getTime()) > SKEW_MS ? now : sent;

  if (event.user?.ip_address === "{{auto}}") event.user.ip_address = clientIp;
  const fp = fingerprint(event);
  const summary = summarize(event);
  const userKey = userIdentity(event);
  const tags = collectTags(event);

  const result = await transaction(async (db) => {
    const existing = await db.query<{ id: number }>("SELECT id FROM events WHERE project_id = $1 AND event_id = $2", [projectId, event.event_id]);
    if (existing.rowCount) return null;

    const { issueId, isNew, previousStatus } = await upsertIssue(db, projectId, fp, summary, event, occurredAt);
    const isRegression = previousStatus === "resolved";

    await db.query(
      `INSERT INTO events (event_id, project_id, issue_id, occurred_at, level, platform, environment, release, transaction_name, message, user_key, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (project_id, event_id) DO NOTHING`,
      [
        event.event_id,
        projectId,
        issueId,
        occurredAt,
        event.level,
        event.platform,
        event.environment ?? null,
        event.release ?? null,
        event.transaction ?? null,
        summary.title,
        userKey,
        JSON.stringify({ ...event, fingerprint_hash: fp }),
      ],
    );

    if (tags.length) {
      await db.query(
        `INSERT INTO issue_tags (issue_id, key, value, times_seen, first_seen, last_seen)
         SELECT $1, k, v, 1, $4, $4 FROM unnest($2::text[], $3::text[]) AS t(k, v)
         ON CONFLICT (issue_id, key, value) DO UPDATE SET times_seen = issue_tags.times_seen + 1, last_seen = GREATEST(issue_tags.last_seen, EXCLUDED.last_seen)`,
        [issueId, tags.map((t) => t[0]), tags.map((t) => t[1]), occurredAt],
      );
    }
    if (userKey) {
      await db.query(`INSERT INTO issue_users (issue_id, user_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [issueId, userKey]);
    }
    await db.query(
      `INSERT INTO issue_hourly (issue_id, hour, count) VALUES ($1, date_trunc('hour', $2::timestamptz), 1)
       ON CONFLICT (issue_id, hour) DO UPDATE SET count = issue_hourly.count + 1`,
      [issueId, occurredAt],
    );
    return { issueId, isNew, isRegression };
  });

  if (!result) return { issueId: 0, eventId: event.event_id, isNew: false, isRegression: false, duplicate: true };

  const kind: AlertKind | null = result.isNew ? "new" : result.isRegression ? "regression" : null;
  if (kind) sendIssueAlert(projectId, result.issueId, kind).catch((err) => console.error("[alerts] failed:", err));
  return { ...result, eventId: event.event_id, duplicate: false };
}

async function upsertIssue(
  db: pg.PoolClient,
  projectId: number,
  fp: string,
  summary: ReturnType<typeof summarize>,
  event: IncomingEvent,
  occurredAt: Date,
): Promise<{ issueId: number; isNew: boolean; previousStatus: string | null }> {
  const inserted = await db.query<{ id: number }>(
    `INSERT INTO issues (project_id, fingerprint, title, culprit, type, value, level, platform, times_seen, first_seen, last_seen, first_release, last_release)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$9,$10,$10)
     ON CONFLICT (project_id, fingerprint) DO NOTHING
     RETURNING id`,
    [projectId, fp, summary.title, summary.culprit, summary.type, summary.value, event.level, event.platform, occurredAt, event.release ?? null],
  );
  if (inserted.rowCount) return { issueId: inserted.rows[0].id, isNew: true, previousStatus: null };

  const current = await db.query<{ id: number; status: string }>(
    `SELECT id, status FROM issues WHERE project_id = $1 AND fingerprint = $2 FOR UPDATE`,
    [projectId, fp],
  );
  const { id, status } = current.rows[0];
  await db.query(
    `UPDATE issues SET
       times_seen = times_seen + 1,
       last_seen = GREATEST(last_seen, $2),
       last_release = COALESCE($3, last_release),
       title = $4, culprit = COALESCE($5, culprit), value = COALESCE($6, value),
       level = $7,
       status = CASE WHEN status = 'resolved' THEN 'unresolved' ELSE status END,
       resolved_at = CASE WHEN status = 'resolved' THEN NULL ELSE resolved_at END
     WHERE id = $1`,
    [id, occurredAt, event.release ?? null, summary.title, summary.culprit, summary.value, event.level],
  );
  return { issueId: id, isNew: false, previousStatus: status };
}

function userIdentity(event: IncomingEvent): string | null {
  const u = event.user as Record<string, unknown> | undefined;
  if (!u) return null;
  for (const key of ["id", "email", "username", "ip_address"]) {
    const v = u[key];
    if (v !== undefined && v !== null && v !== "") return `${key}:${String(v)}`.slice(0, 200);
  }
  return null;
}

/** Tags shown on the issue page and usable as filters. */
function collectTags(event: IncomingEvent): Array<[string, string]> {
  const tags = new Map<string, string>();
  const set = (k: string, v: unknown) => {
    if (v === undefined || v === null || v === "") return;
    tags.set(k.slice(0, 64), String(v).slice(0, 200));
  };
  set("environment", event.environment);
  set("release", event.release);
  set("level", event.level);
  set("transaction", event.transaction);
  set("server_name", event.server_name);
  const c = event.contexts ?? {};
  set("browser", c.browser?.name && `${c.browser.name}${c.browser.version ? ` ${c.browser.version}` : ""}`);
  set("browser.name", c.browser?.name);
  set("os", c.os?.name && `${c.os.name}${c.os.version ? ` ${c.os.version}` : ""}`);
  set("device", c.device?.family);
  set("runtime", c.runtime?.name && `${c.runtime.name} ${c.runtime.version ?? ""}`.trim());
  if (event.request?.url) set("url", event.request.url.split("?")[0]);
  set("mechanism", event.exception?.values[0]?.mechanism?.type);
  set("handled", event.exception?.values[0]?.mechanism ? (event.exception.values[0].mechanism.handled ? "yes" : "no") : undefined);
  for (const [k, v] of Object.entries(event.tags ?? {})) {
    if (tags.size >= MAX_TAGS) break;
    set(k, v);
  }
  return [...tags.entries()];
}

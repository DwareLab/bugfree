import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth";
import { one, query } from "../db";
import { HttpError, intParam, notFound, parseBody } from "./http";

export const issuesRouter = Router();
issuesRouter.use(["/api/issues", "/api/projects/:projectId/issues", "/api/events"], requireAuth);

const PAGE_SIZE = 50;
const SORTS: Record<string, string> = {
  last_seen: "i.last_seen DESC",
  first_seen: "i.first_seen DESC",
  times_seen: "i.times_seen DESC",
  users: "users_count DESC, i.last_seen DESC",
};

/** Splits `TypeError browser:"Mobile Safari" is:resolved` into free text and key:value filters. */
export function parseSearch(q: string): { text: string[]; filters: Array<[string, string]> } {
  const text: string[] = [];
  const filters: Array<[string, string]> = [];
  for (const m of q.matchAll(/(\S+?):"([^"]*)"|(\S+?):(\S+)|"([^"]*)"|(\S+)/g)) {
    if (m[1]) filters.push([m[1], m[2]]);
    else if (m[3] && !/^https?$/.test(m[3])) filters.push([m[3], m[4]]);
    else text.push(m[5] ?? m[0]);
  }
  return { text, filters };
}

issuesRouter.get("/api/projects/:projectId/issues", async (req, res) => {
  const projectId = intParam(req, "projectId");
  const params: unknown[] = [projectId];
  const where = ["i.project_id = $1"];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };

  let status = typeof req.query.status === "string" ? req.query.status : "unresolved";
  const { text, filters } = parseSearch(typeof req.query.query === "string" ? req.query.query : "");
  for (const [key, value] of filters) {
    if (key === "is") {
      status = value;
      continue;
    }
    where.push(`EXISTS (SELECT 1 FROM issue_tags t WHERE t.issue_id = i.id AND t.key = ${add(key)} AND (t.value = ${add(value)} OR t.value ILIKE ${add(`${value.replace(/[%_\\]/g, "\\$&")}%`)}))`);
  }
  for (const word of text) {
    const p = add(`%${word.replace(/[%_\\]/g, "\\$&")}%`);
    where.push(`(i.title ILIKE ${p} OR i.culprit ILIKE ${p})`);
  }
  if (status !== "all") where.push(`i.status = ${add(status)}`);
  for (const key of ["environment", "release"] as const) {
    const v = req.query[key];
    if (typeof v === "string" && v) where.push(`EXISTS (SELECT 1 FROM issue_tags t WHERE t.issue_id = i.id AND t.key = '${key}' AND t.value = ${add(v)})`);
  }
  const sort = SORTS[String(req.query.sort)] ?? SORTS.last_seen;
  const offset = Math.max(0, Number(req.query.offset) || 0);

  const rows = await query(
    `SELECT i.id, i.title, i.culprit, i.type, i.level, i.status, i.platform, i.times_seen, i.first_seen, i.last_seen,
            i.first_release, i.last_release,
            (SELECT count(*)::int FROM issue_users u WHERE u.issue_id = i.id) AS users_count,
            count(*) OVER()::int AS total
     FROM issues i
     WHERE ${where.join(" AND ")}
     ORDER BY ${sort}, i.id DESC
     LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
    params,
  );

  // 24 hourly buckets per issue for the sparkline column.
  const ids = rows.map((r) => r.id);
  const hourly = ids.length
    ? await query<{ issue_id: number; idx: number; count: number }>(
        `SELECT issue_id, (23 - floor(extract(epoch FROM date_trunc('hour', now()) - hour) / 3600))::int AS idx, count::int
         FROM issue_hourly WHERE issue_id = ANY($1) AND hour > date_trunc('hour', now()) - interval '24 hours'`,
        [ids],
      )
    : [];
  const spark = new Map<number, number[]>(ids.map((id) => [id, new Array(24).fill(0)]));
  for (const h of hourly) if (h.idx >= 0 && h.idx < 24) spark.get(h.issue_id)![h.idx] = h.count;

  res.json({
    total: rows[0]?.total ?? 0,
    offset,
    pageSize: PAGE_SIZE,
    issues: rows.map(({ total: _t, ...r }) => ({ ...r, hourly: spark.get(r.id) })),
  });
});

const statusBody = z.object({ status: z.enum(["unresolved", "resolved", "ignored"]) });

issuesRouter.patch("/api/projects/:projectId/issues", async (req, res) => {
  const projectId = intParam(req, "projectId");
  const body = parseBody(statusBody.extend({ ids: z.array(z.number().int().positive()).min(1).max(500) }), req);
  const rows = await query(
    `UPDATE issues SET status = $3, resolved_at = CASE WHEN $3 = 'resolved' THEN now() ELSE NULL END
     WHERE project_id = $1 AND id = ANY($2) RETURNING id`,
    [projectId, body.ids, body.status],
  );
  res.json({ updated: rows.length });
});

issuesRouter.get("/api/issues/:id", async (req, res) => {
  const id = intParam(req, "id");
  const issue = await one(
    `SELECT i.*, p.name AS project_name,
       (SELECT count(*)::int FROM issue_users u WHERE u.issue_id = i.id) AS users_count,
       (SELECT id FROM events e WHERE e.issue_id = i.id ORDER BY e.received_at DESC, e.id DESC LIMIT 1) AS latest_event_id,
       (SELECT id FROM events e WHERE e.issue_id = i.id ORDER BY e.received_at ASC, e.id ASC LIMIT 1) AS oldest_event_id,
       (SELECT count(*)::int FROM events e WHERE e.issue_id = i.id) AS stored_events
     FROM issues i JOIN projects p ON p.id = i.project_id WHERE i.id = $1`,
    [id],
  );
  if (!issue) return notFound(res);

  const tagRows = await query<{ key: string; value: string; times_seen: number; total: number; rank: number }>(
    `SELECT key, value, times_seen::int, sum(times_seen) OVER (PARTITION BY key)::int AS total,
            row_number() OVER (PARTITION BY key ORDER BY times_seen DESC, value) AS rank
     FROM issue_tags WHERE issue_id = $1`,
    [id],
  );
  const tags: Record<string, { total: number; values: Array<{ value: string; count: number }> }> = {};
  for (const t of tagRows) {
    tags[t.key] ??= { total: t.total, values: [] };
    if (t.rank <= 5) tags[t.key].values.push({ value: t.value, count: t.times_seen });
  }

  const [hourly, daily] = await Promise.all([
    query(
      `SELECT s.t, coalesce(h.count, 0)::int AS count
       FROM generate_series(date_trunc('hour', now()) - interval '23 hours', date_trunc('hour', now()), interval '1 hour') AS s(t)
       LEFT JOIN issue_hourly h ON h.issue_id = $1 AND h.hour = s.t ORDER BY s.t`,
      [id],
    ),
    query(
      `SELECT s.t, coalesce(sum(h.count), 0)::int AS count
       FROM generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') AS s(t)
       LEFT JOIN issue_hourly h ON h.issue_id = $1 AND date_trunc('day', h.hour) = s.t
       GROUP BY s.t ORDER BY s.t`,
      [id],
    ),
  ]);

  res.json({ ...issue, tags, stats: { hourly, daily } });
});

issuesRouter.patch("/api/issues/:id", async (req, res) => {
  const id = intParam(req, "id");
  const { status } = parseBody(statusBody, req);
  const issue = await one(
    `UPDATE issues SET status = $2, resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE NULL END WHERE id = $1 RETURNING id, status, resolved_at`,
    [id, status],
  );
  if (!issue) return notFound(res);
  res.json(issue);
});

issuesRouter.delete("/api/issues/:id", async (req, res) => {
  await query(`DELETE FROM issues WHERE id = $1`, [intParam(req, "id")]);
  res.json({ ok: true });
});

issuesRouter.get("/api/issues/:id/events", async (req, res) => {
  const id = intParam(req, "id");
  const before = Number(req.query.before) || null;
  const rows = await query(
    `SELECT id, event_id, occurred_at, received_at, level, environment, release, transaction_name, message, user_key,
            data->'request'->>'url' AS url,
            data->'contexts'->'browser'->>'name' AS browser
     FROM events WHERE issue_id = $1 AND ($2::bigint IS NULL OR id < $2)
     ORDER BY id DESC LIMIT 50`,
    [id, before],
  );
  res.json({ events: rows, next: rows.length === 50 ? rows[rows.length - 1].id : null });
});

/** One event of an issue: "latest", "oldest" or an event row id, with neighbours for navigation. */
issuesRouter.get("/api/issues/:id/events/:which", async (req, res) => {
  const issueId = intParam(req, "id");
  const which = req.params.which;
  let event;
  if (which === "latest" || which === "oldest") {
    event = await one(`SELECT * FROM events WHERE issue_id = $1 ORDER BY id ${which === "latest" ? "DESC" : "ASC"} LIMIT 1`, [issueId]);
  } else {
    const eventRowId = Number(which);
    if (!Number.isSafeInteger(eventRowId)) throw new HttpError(404, "Not found");
    event = await one(`SELECT * FROM events WHERE issue_id = $1 AND id = $2`, [issueId, eventRowId]);
  }
  if (!event) return notFound(res, "No stored events for this issue");
  const [prev, next] = await Promise.all([
    one<{ id: number }>(`SELECT id FROM events WHERE issue_id = $1 AND id < $2 ORDER BY id DESC LIMIT 1`, [issueId, event.id]),
    one<{ id: number }>(`SELECT id FROM events WHERE issue_id = $1 AND id > $2 ORDER BY id ASC LIMIT 1`, [issueId, event.id]),
  ]);
  res.json({ ...event, prev_id: prev?.id ?? null, next_id: next?.id ?? null });
});

/** Find an event by the SDK-generated id (shown to users, e.g. on an error page). */
issuesRouter.get("/api/events/:eventId", async (req, res) => {
  const event = await one(`SELECT id, issue_id, project_id FROM events WHERE event_id = $1`, [String(req.params.eventId).replace(/-/g, "").toLowerCase()]);
  if (!event) return notFound(res);
  res.json(event);
});

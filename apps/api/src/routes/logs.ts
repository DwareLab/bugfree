import express, { Router } from "express";
import { requireAuth } from "../auth";
import { config } from "../config";
import { query } from "../db";
import { LOG_LEVELS, logBatchSchema, normalizeLog } from "../logs/normalize";
import { projectKey, rateLimiter } from "./ingest";
import { HttpError, intParam } from "./http";
import { parseSearch } from "./issues";

/** Log ingest from the Docker agent (or any collector): authenticated with the project's DSN key, no session. */
export const logsIngestRouter = Router();
/** Dashboard log search. */
export const logsRouter = Router();

const allow = rateLimiter(() => config.logRateLimit);

logsIngestRouter.post(
  "/api/logs/:projectId",
  // Agents may gzip the body (Content-Encoding: gzip); the limit applies to the inflated size.
  express.json({ type: () => true, limit: "10mb" }),
  async (req, res) => {
    const projectId = Number(req.params.projectId);
    const key = String(req.query.key ?? req.get("x-bugfree-key") ?? "");
    if (!Number.isSafeInteger(projectId) || !key) {
      res.status(401).json({ error: "Missing project id or key" });
      return;
    }
    const expected = await projectKey(projectId);
    if (!expected || expected !== key) {
      res.status(401).json({ error: "Invalid project or key" });
      return;
    }
    const parsed = logBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid log batch", issues: parsed.error.issues.slice(0, 10) });
      return;
    }
    if (!allow(projectId, parsed.data.logs.length)) {
      res.setHeader("Retry-After", "5");
      res.status(429).json({ error: "Rate limit exceeded" });
      return;
    }
    const now = new Date();
    const rows = parsed.data.logs.map((l) => normalizeLog(l, parsed.data.host, now));
    const col = <K extends keyof (typeof rows)[number]>(k: K) => rows.map((r) => r[k]);
    await query(
      `INSERT INTO logs (project_id, ts, level, stream, host, container, service, image, container_id, message, attributes)
       SELECT $1, * FROM unnest($2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::jsonb[])
       ON CONFLICT (project_id, container_id, ts, md5(message)) DO NOTHING`,
      [
        projectId,
        col("ts"),
        col("level"),
        col("stream"),
        col("host"),
        col("container"),
        col("service"),
        col("image"),
        col("container_id"),
        // NUL bytes are not allowed in Postgres text.
        col("message").map((m) => m.replaceAll("\u0000", "")),
        col("attributes").map((a) => (a ? JSON.stringify(a).replaceAll("\\u0000", "") : null)),
      ],
    );
    res.json({ accepted: rows.length });
  },
);

// ---- Search ----

export interface LogFilters {
  /** Free text (substring match) and `container:` `service:` `host:` `level:` `stream:` or `<json field>:value` filters. */
  query?: string;
  container?: string;
  level?: string;
  from?: Date;
  to?: Date;
}

const COLUMNS: Record<string, string> = {
  container: "container",
  service: "service",
  host: "host",
  image: "image",
  container_id: "container_id",
  stream: "stream",
  level: "level",
};
const like = (s: string) => `%${s.replace(/[%_\\]/g, "\\$&")}%`;

function buildWhere(projectId: number, f: LogFilters) {
  const params: unknown[] = [projectId];
  const where = ["project_id = $1"];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const { text, filters } = parseSearch(f.query ?? "");
  for (const [key, value] of filters) {
    const column = COLUMNS[key.toLowerCase()];
    if (column) where.push(`${column} = ${add(column === "level" ? value.toLowerCase() : value)}`);
    // Anything else that looks like a field name filters structured (JSON) log fields; `127.0.0.1:5432` stays text.
    else if (/^[A-Za-z_@][\w.@-]*$/.test(key)) where.push(`attributes->>${add(key)} = ${add(value)}`);
    else text.push(`${key}:${value}`);
  }
  for (const word of text) where.push(`message ILIKE ${add(like(word))}`);
  if (f.container) where.push(`container = ${add(f.container)}`);
  if (f.level) {
    // "warning" means warning and worse.
    const idx = LOG_LEVELS.indexOf(f.level as (typeof LOG_LEVELS)[number]);
    if (idx < 0) throw new HttpError(400, "Unknown level");
    where.push(`level = ANY(${add(LOG_LEVELS.slice(0, idx + 1))})`);
  }
  if (f.from) where.push(`ts >= ${add(f.from)}`);
  if (f.to) where.push(`ts < ${add(f.to)}`);
  return { where, params, add };
}

const ROW = `id, to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts, level, stream, host, container, service, image, container_id, message, attributes`;
export const LOG_PAGE_SIZE = 200;

/**
 * Newest first. `before` is the `next` cursor of the previous page (ts|id). `afterId` returns rows inserted after
 * that id (live tail), newest first.
 */
export async function searchLogs(projectId: number, f: LogFilters & { before?: string; afterId?: number; limit?: number }) {
  const { where, params, add } = buildWhere(projectId, f);
  const limit = Math.min(LOG_PAGE_SIZE, Math.max(1, f.limit ?? LOG_PAGE_SIZE));
  if (f.before) {
    const [ts, id] = f.before.split("|");
    if (!ts || !Number.isSafeInteger(Number(id)) || Number.isNaN(Date.parse(ts))) throw new HttpError(400, "Invalid cursor");
    where.push(`(ts, id) < (${add(ts)}::timestamptz, ${add(Number(id))})`);
  }
  if (f.afterId) where.push(`id > ${add(f.afterId)}`);
  const rows = await query(`SELECT ${ROW} FROM logs WHERE ${where.join(" AND ")} ORDER BY ts DESC, id DESC LIMIT ${limit + 1}`, params);
  const more = rows.length > limit;
  const logs = more ? rows.slice(0, limit) : rows;
  const last = logs[logs.length - 1];
  return { logs, next: more && last ? `${last.ts}|${last.id}` : null };
}

const BUCKETS = [60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400];

/** Line counts (and error-or-worse counts) over time, about 60 buckets across the range. */
export async function logVolume(projectId: number, f: LogFilters) {
  const to = f.to ?? new Date();
  const from = f.from ?? new Date(to.getTime() - config.logRetentionDays * 86_400_000);
  const span = (to.getTime() - from.getTime()) / 1000;
  const bucket = BUCKETS.find((b) => span / b <= 72) ?? 86400;
  const { where, params, add } = buildWhere(projectId, { ...f, from, to });
  const b = add(`${bucket} seconds`);
  const origin = add(new Date(0));
  const start = add(from);
  const end = add(to);
  const points = await query<{ t: Date; count: number; errors: number }>(
    `WITH series AS (
       SELECT generate_series(date_bin(${b}::interval, ${start}::timestamptz, ${origin}::timestamptz), ${end}::timestamptz, ${b}::interval) AS t
     ), counts AS (
       SELECT date_bin(${b}::interval, ts, ${origin}::timestamptz) AS t, count(*)::int AS count,
              count(*) FILTER (WHERE level IN ('error', 'fatal'))::int AS errors
       FROM logs WHERE ${where.join(" AND ")} GROUP BY 1
     )
     SELECT s.t, coalesce(c.count, 0) AS count, coalesce(c.errors, 0) AS errors
     FROM series s LEFT JOIN counts c USING (t) ORDER BY s.t`,
    params,
  );
  return { bucket_seconds: bucket, points };
}

/** Every container that has logs (including ones that no longer exist), most recently active first. */
export function logSources(projectId: number) {
  // Skip scan over (project_id, container): one index probe per distinct container instead of reading every row.
  return query(
    `WITH RECURSIVE c AS (
       (SELECT container FROM logs WHERE project_id = $1 AND container IS NOT NULL ORDER BY container LIMIT 1)
       UNION ALL
       SELECT (SELECT l.container FROM logs l WHERE l.project_id = $1 AND l.container > c.container ORDER BY l.container LIMIT 1)
       FROM c WHERE c.container IS NOT NULL
     )
     SELECT c.container, last.ts AS last_seen, last.service, last.host, last.image
     FROM c CROSS JOIN LATERAL (
       SELECT ts, service, host, image FROM logs l WHERE l.project_id = $1 AND l.container = c.container ORDER BY ts DESC LIMIT 1
     ) last
     WHERE c.container IS NOT NULL
     ORDER BY last.ts DESC LIMIT 500`,
    [projectId],
  );
}

// ---- Dashboard routes ----

logsRouter.use("/api/projects/:projectId/logs", requireAuth);

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
function date(v: unknown): Date | undefined {
  const s = str(v);
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, "Invalid date");
  return d;
}
function filters(q: Record<string, unknown>): LogFilters {
  return { query: str(q.query), container: str(q.container), level: str(q.level), from: date(q.from), to: date(q.to) };
}

logsRouter.get("/api/projects/:projectId/logs", async (req, res) => {
  const afterId = Number(req.query.after_id);
  res.json(
    await searchLogs(intParam(req, "projectId"), {
      ...filters(req.query),
      before: str(req.query.before),
      afterId: Number.isSafeInteger(afterId) && afterId > 0 ? afterId : undefined,
    }),
  );
});

logsRouter.get("/api/projects/:projectId/logs/volume", async (req, res) => {
  res.json(await logVolume(intParam(req, "projectId"), filters(req.query)));
});

logsRouter.get("/api/projects/:projectId/logs/sources", async (req, res) => {
  res.json(await logSources(intParam(req, "projectId")));
});

import { Router } from "express";
import { z } from "zod";
import { sendTestAlert } from "../alerts";
import { randomKey, requireAuth } from "../auth";
import { config } from "../config";
import { one, query } from "../db";
import { forgetProjectKey } from "./ingest";
import { HttpError, intParam, notFound, parseBody } from "./http";

export const projectsRouter = Router();
projectsRouter.use("/api/projects", requireAuth);

export function dsnFor(project: { id: number; public_key: string }): string {
  const url = new URL(config.apiUrl);
  const prefix = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${project.public_key}@${url.host}${prefix}/${project.id}`;
}

function present(p: Record<string, any>) {
  return { ...p, dsn: dsnFor(p as { id: number; public_key: string }), api_url: config.apiUrl };
}

projectsRouter.get("/api/projects", async (_req, res) => {
  const rows = await query(
    `SELECT p.id, p.name, p.platform, p.created_at,
       (SELECT count(*)::int FROM issues i WHERE i.project_id = p.id AND i.status = 'unresolved') AS unresolved_issues,
       (SELECT coalesce(sum(h.count), 0)::int FROM issue_hourly h JOIN issues i ON i.id = h.issue_id
          WHERE i.project_id = p.id AND h.hour > now() - interval '24 hours') AS events_24h,
       (SELECT max(i.last_seen) FROM issues i WHERE i.project_id = p.id) AS last_event_at
     FROM projects p ORDER BY p.name`,
  );
  res.json(rows);
});

const platform = z.enum(["nextjs", "express", "node", "browser"]);

projectsRouter.post("/api/projects", async (req, res) => {
  const body = parseBody(z.object({ name: z.string().trim().min(1).max(100), platform: platform.default("nextjs") }), req);
  const project = await one(
    `INSERT INTO projects (name, platform, public_key, secret_key) VALUES ($1, $2, $3, $4) RETURNING *`,
    [body.name, body.platform, randomKey(16), `bfs_${randomKey(24)}`],
  );
  res.status(201).json(present(project));
});

projectsRouter.get("/api/projects/:id", async (req, res) => {
  const project = await one(`SELECT * FROM projects WHERE id = $1`, [intParam(req, "id")]);
  if (!project) return notFound(res);
  res.json(present(project));
});

projectsRouter.patch("/api/projects/:id", async (req, res) => {
  const id = intParam(req, "id");
  const body = parseBody(
    z.object({
      name: z.string().trim().min(1).max(100).optional(),
      platform: platform.optional(),
      alert_webhook_url: z.union([z.url({ protocol: /^https?$/ }), z.literal(""), z.null()]).optional(),
      alert_emails: z.string().max(1000).nullable().optional(),
      alert_on_new: z.boolean().optional(),
      alert_on_regression: z.boolean().optional(),
    }),
    req,
  );
  const fields = Object.entries(body).filter(([, v]) => v !== undefined);
  if (!fields.length) throw new HttpError(400, "Nothing to update");
  const sets = fields.map(([k], i) => `${k} = $${i + 2}`).join(", ");
  const values = fields.map(([, v]) => (v === "" ? null : v));
  const project = await one(`UPDATE projects SET ${sets} WHERE id = $1 RETURNING *`, [id, ...values]);
  if (!project) return notFound(res);
  res.json(present(project));
});

projectsRouter.post("/api/projects/:id/rotate-keys", async (req, res) => {
  const id = intParam(req, "id");
  const which = parseBody(z.object({ key: z.enum(["public", "secret"]) }), req).key;
  const project = await one(
    which === "public"
      ? `UPDATE projects SET public_key = $2 WHERE id = $1 RETURNING *`
      : `UPDATE projects SET secret_key = $2 WHERE id = $1 RETURNING *`,
    [id, which === "public" ? randomKey(16) : `bfs_${randomKey(24)}`],
  );
  if (!project) return notFound(res);
  forgetProjectKey(id);
  res.json(present(project));
});

projectsRouter.post("/api/projects/:id/test-alert", async (req, res) => {
  res.json(await sendTestAlert(intParam(req, "id")));
});

projectsRouter.delete("/api/projects/:id", async (req, res) => {
  const id = intParam(req, "id");
  await query(`DELETE FROM projects WHERE id = $1`, [id]);
  forgetProjectKey(id);
  res.json({ ok: true });
});

/** Event volume for the project: hourly for 24h or daily for 14/30 days. */
projectsRouter.get("/api/projects/:id/stats", async (req, res) => {
  const id = intParam(req, "id");
  const period = req.query.period === "14d" ? "14d" : req.query.period === "30d" ? "30d" : "24h";
  const [bucket, span, steps] = period === "24h" ? ["hour", "24 hours", 24] : period === "14d" ? ["day", "14 days", 14] : ["day", "30 days", 30];
  const rows = await query<{ t: Date; count: number }>(
    `WITH series AS (
       SELECT generate_series(date_trunc('${bucket}', now()) - interval '${span}' + interval '1 ${bucket}', date_trunc('${bucket}', now()), interval '1 ${bucket}') AS t
     )
     SELECT s.t, coalesce(sum(h.count), 0)::int AS count
     FROM series s
     LEFT JOIN issue_hourly h ON date_trunc('${bucket}', h.hour) = s.t
       AND h.issue_id IN (SELECT id FROM issues WHERE project_id = $1)
     GROUP BY s.t ORDER BY s.t`,
    [id],
  );
  res.json({ period, steps, points: rows });
});

projectsRouter.get("/api/projects/:id/environments", async (req, res) => {
  const rows = await query<{ value: string }>(
    `SELECT DISTINCT t.value FROM issue_tags t JOIN issues i ON i.id = t.issue_id WHERE i.project_id = $1 AND t.key = 'environment' ORDER BY 1`,
    [intParam(req, "id")],
  );
  res.json(rows.map((r) => r.value));
});

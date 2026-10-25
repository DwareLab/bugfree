import express, { type NextFunction, type Request, type Response, Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth";
import { one, query } from "../db";
import { symbolicator } from "../ingest/process";
import { HttpError, intParam, parseBody } from "./http";

export const releasesRouter = Router();
/** Source map uploads from the CLI; mounted before the dashboard middleware (no session, CORS or Origin check). */
export const cliRouter = Router();

releasesRouter.get("/api/projects/:projectId/releases", requireAuth, async (req, res) => {
  const projectId = intParam(req, "projectId");
  const rows = await query(
    `WITH versions AS (
       SELECT version, created_at FROM releases WHERE project_id = $1
       UNION ALL
       SELECT release, min(received_at) FROM events WHERE project_id = $1 AND release IS NOT NULL GROUP BY release
     )
     SELECT v.version, min(v.created_at) AS created_at,
       (SELECT count(*)::int FROM artifacts a JOIN releases r ON r.id = a.release_id WHERE r.project_id = $1 AND r.version = v.version) AS artifact_count,
       (SELECT coalesce(sum(a.size), 0)::bigint FROM artifacts a JOIN releases r ON r.id = a.release_id WHERE r.project_id = $1 AND r.version = v.version) AS artifact_bytes,
       (SELECT count(*)::int FROM issues i WHERE i.project_id = $1 AND i.first_release = v.version) AS new_issues,
       (SELECT count(*)::int FROM events e WHERE e.project_id = $1 AND e.release = v.version) AS events
     FROM versions v GROUP BY v.version ORDER BY min(v.created_at) DESC LIMIT 100`,
    [projectId],
  );
  res.json(rows);
});

releasesRouter.get("/api/projects/:projectId/releases/:version/artifacts", requireAuth, async (req, res) => {
  const rows = await query(
    `SELECT a.id, a.name, a.size, a.created_at FROM artifacts a JOIN releases r ON r.id = a.release_id
     WHERE r.project_id = $1 AND r.version = $2 ORDER BY a.name`,
    [intParam(req, "projectId"), req.params.version],
  );
  res.json(rows);
});

releasesRouter.delete("/api/projects/:projectId/releases/:version/artifacts", requireAuth, async (req, res) => {
  const projectId = intParam(req, "projectId");
  await query(`DELETE FROM artifacts WHERE release_id IN (SELECT id FROM releases WHERE project_id = $1 AND version = $2)`, [projectId, req.params.version]);
  symbolicator.forget(projectId, String(req.params.version));
  res.json({ ok: true });
});

// ---- CLI (authenticated with the project's secret key) ----

declare module "express-serve-static-core" {
  interface Request {
    cliProjectId?: number;
  }
}

async function cliAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const project = token ? await one<{ id: number }>(`SELECT id FROM projects WHERE secret_key = $1`, [token]) : undefined;
  if (!project) {
    res.status(401).json({ error: "Invalid auth token (use the project's secret key)" });
    return;
  }
  req.cliProjectId = project.id;
  next();
}

async function ensureRelease(projectId: number, version: string): Promise<number> {
  const row = await one<{ id: number }>(
    `INSERT INTO releases (project_id, version) VALUES ($1, $2)
     ON CONFLICT (project_id, version) DO UPDATE SET version = EXCLUDED.version RETURNING id`,
    [projectId, version],
  );
  return row!.id;
}

const version = z.string().trim().min(1).max(200);

cliRouter.post("/api/cli/releases", cliAuth, express.json(), async (req, res) => {
  const body = parseBody(z.object({ version }), req);
  await ensureRelease(req.cliProjectId!, body.version);
  res.status(201).json({ version: body.version });
});

cliRouter.post(
  "/api/cli/releases/:version/artifacts",
  cliAuth,
  express.raw({ type: () => true, limit: "100mb" }),
  async (req, res) => {
    const releaseVersion = version.safeParse(req.params.version);
    const name = String(req.query.name ?? "");
    if (!releaseVersion.success) throw new HttpError(400, "Invalid release");
    if (!name || name.length > 1000 || !name.startsWith("~/")) throw new HttpError(400, "name must start with ~/");
    const content = req.body as Buffer;
    if (!Buffer.isBuffer(content) || !content.length) throw new HttpError(400, "Empty body");
    try {
      JSON.parse(content.toString("utf8"));
    } catch {
      throw new HttpError(400, "Artifact is not a valid JSON source map");
    }
    const releaseId = await ensureRelease(req.cliProjectId!, releaseVersion.data);
    await query(
      `INSERT INTO artifacts (release_id, name, size, content) VALUES ($1, $2, $3, $4)
       ON CONFLICT (release_id, name) DO UPDATE SET content = EXCLUDED.content, size = EXCLUDED.size, created_at = now()`,
      [releaseId, name, content.length, content],
    );
    symbolicator.forget(req.cliProjectId!, releaseVersion.data);
    res.status(201).json({ name, size: content.length });
  },
);

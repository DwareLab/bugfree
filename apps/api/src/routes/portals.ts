import { Router } from "express";
import { z } from "zod";
import { randomKey, requireAuth } from "../auth";
import { config } from "../config";
import { one, query, transaction } from "../db";
import { HttpError, intParam, notFound, parseBody } from "./http";

/** Report pages: public pages, each covering one or more projects, where people report bugs. */
export const portalsRouter = Router();
portalsRouter.use("/api/portals", requireAuth);

export const portalUrlFor = (slug: string) => `${config.appUrls[0]}/report/${encodeURIComponent(slug)}`;

/** e.g. "my-shop-3fa9c1": readable, and not guessable from the name alone. */
function newSlug(name: string): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${base || "report"}-${randomKey(3)}`;
}

const PORTAL_FIELDS = `po.id, po.name, po.slug, po.enabled, po.intro, po.ask_project, po.alert_webhook_url, po.alert_emails, po.created_at,
  coalesce((SELECT json_agg(json_build_object('id', p.id, 'name', p.name, 'label', pp.label) ORDER BY pp.position, p.name)
            FROM portal_projects pp JOIN projects p ON p.id = pp.project_id WHERE pp.portal_id = po.id), '[]') AS projects,
  (SELECT count(*)::int FROM tickets t WHERE t.portal_id = po.id AND t.status = 'new') AS new_tickets,
  (SELECT count(*)::int FROM tickets t WHERE t.portal_id = po.id AND t.project_id IS NULL AND t.status NOT IN ('done', 'wont_fix')) AS unrouted_tickets`;

function present(p: Record<string, any>) {
  return { ...p, url: portalUrlFor(p.slug), api_url: config.apiUrl, github_configured: !!(config.githubClientId && config.githubClientSecret) };
}

async function getPortal(id: number) {
  const portal = await one(`SELECT ${PORTAL_FIELDS} FROM portals po WHERE po.id = $1`, [id]);
  return portal && present(portal);
}

export async function listPortals() {
  return (await query(`SELECT ${PORTAL_FIELDS} FROM portals po ORDER BY po.name`)).map(present);
}

portalsRouter.get("/api/portals", async (_req, res) => {
  res.json(await listPortals());
});

const projectIds = z.array(z.number().int().positive()).max(50);

async function setProjects(portalId: number, projects: Array<{ project_id: number; label?: string | null }>, db: Parameters<typeof query>[2]) {
  const ids = projects.map((p) => p.project_id);
  if (new Set(ids).size !== ids.length) throw new HttpError(400, "projects: each project can be listed once");
  const found = await query<{ id: number }>(`SELECT id FROM projects WHERE id = ANY($1::bigint[])`, [ids], db);
  if (found.length !== ids.length) throw new HttpError(400, "projects: no such project");
  await query(`DELETE FROM portal_projects WHERE portal_id = $1`, [portalId], db);
  for (const [i, p] of projects.entries()) {
    await query(`INSERT INTO portal_projects (portal_id, project_id, label, position) VALUES ($1, $2, $3, $4)`, [portalId, p.project_id, p.label?.trim() || null, i], db);
  }
}

portalsRouter.post("/api/portals", async (req, res) => {
  const body = parseBody(z.object({ name: z.string().trim().min(1).max(100), project_ids: projectIds.min(1, "pick at least one project") }), req);
  const id = await transaction(async (client) => {
    const portal = await one<{ id: number }>(`INSERT INTO portals (name, slug) VALUES ($1, $2) RETURNING id`, [body.name, newSlug(body.name)], client);
    await setProjects(portal!.id, body.project_ids.map((project_id) => ({ project_id })), client);
    return portal!.id;
  });
  res.status(201).json(await getPortal(id));
});

portalsRouter.get("/api/portals/:id", async (req, res) => {
  const portal = await getPortal(intParam(req, "id"));
  if (!portal) return notFound(res);
  res.json(portal);
});

portalsRouter.patch("/api/portals/:id", async (req, res) => {
  const id = intParam(req, "id");
  const { projects, ...body } = parseBody(
    z.object({
      name: z.string().trim().min(1).max(100).optional(),
      slug: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/, "3–60 lowercase letters, digits and dashes")
        .optional(),
      enabled: z.boolean().optional(),
      intro: z.string().max(2000).nullable().optional(),
      ask_project: z.boolean().optional(),
      alert_webhook_url: z.union([z.url({ protocol: /^https?$/ }), z.literal(""), z.null()]).optional(),
      alert_emails: z.string().max(1000).nullable().optional(),
      projects: z
        .array(z.object({ project_id: z.number().int().positive(), label: z.string().max(100).nullable().optional() }))
        .min(1, "a report page needs at least one project")
        .max(50)
        .optional(),
    }),
    req,
  );
  const fields = Object.entries(body).filter(([, v]) => v !== undefined);
  if (!fields.length && !projects) throw new HttpError(400, "Nothing to update");
  if (body.slug && (await one(`SELECT 1 FROM portals WHERE slug = $1 AND id <> $2`, [body.slug, id]))) throw new HttpError(409, "That address is taken");

  const found = await transaction(async (client) => {
    if (!(await one(`SELECT 1 FROM portals WHERE id = $1 FOR UPDATE`, [id], client))) return false;
    if (fields.length) {
      const sets = fields.map(([k], i) => `${k} = $${i + 2}`).join(", ");
      await query(`UPDATE portals SET ${sets} WHERE id = $1`, [id, ...fields.map(([, v]) => (v === "" ? null : v))], client);
    }
    if (projects) await setProjects(id, projects, client);
    return true;
  });
  if (!found) return notFound(res);
  res.json(await getPortal(id));
});

/** Reports that were routed to a project stay on that project's board; unrouted ones are deleted with the page. */
portalsRouter.delete("/api/portals/:id", async (req, res) => {
  const id = intParam(req, "id");
  await transaction(async (client) => {
    await query(`DELETE FROM tickets WHERE portal_id = $1 AND project_id IS NULL`, [id], client);
    await query(`DELETE FROM portals WHERE id = $1`, [id], client);
  });
  res.json({ ok: true });
});

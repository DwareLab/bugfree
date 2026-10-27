import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth";
import { one, query } from "../db";
import { HttpError, intParam, notFound, parseBody } from "./http";

/** Bug reports from report pages, managed on Kanban boards (one per project and one per report page). */
export const ticketsRouter = Router();
ticketsRouter.use("/api/tickets", requireAuth);

export const TICKET_STATUSES = ["new", "todo", "in_progress", "done", "wont_fix"] as const;
export const SEVERITIES = ["low", "normal", "high", "critical"] as const;
export const CLOSED_STATUSES = new Set(["done", "wont_fix"]);
/** Closed columns show only their most recent tickets. */
const CLOSED_COLUMN_LIMIT = 100;

const TICKET_FIELDS = `t.id, t.title, t.severity, t.status, t.position, t.created_at, t.updated_at, t.closed_at,
  CASE WHEN p.id IS NULL THEN NULL ELSE json_build_object('id', p.id, 'name', p.name) END AS project,
  CASE WHEN po.id IS NULL THEN NULL ELSE json_build_object('id', po.id, 'name', po.name, 'slug', po.slug) END AS portal,
  CASE WHEN r.id IS NULL THEN NULL ELSE json_build_object('login', r.login, 'name', r.name, 'avatar_url', r.avatar_url) END AS reporter,
  CASE WHEN u.id IS NULL THEN NULL ELSE json_build_object('id', u.id, 'email', u.email) END AS assignee,
  (SELECT count(*)::int FROM ticket_comments c WHERE c.ticket_id = t.id) AS comment_count`;

const TICKET_JOINS = `LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN portals po ON po.id = t.portal_id
  LEFT JOIN reporters r ON r.id = t.reporter_id LEFT JOIN users u ON u.id = t.assignee_id`;

async function ticketDetail(id: number) {
  const ticket = await one(`SELECT ${TICKET_FIELDS}, t.description, t.page_url, t.user_agent FROM tickets t ${TICKET_JOINS} WHERE t.id = $1`, [id]);
  if (!ticket) return undefined;
  const comments = await query(
    `SELECT c.id, c.body, c.internal, c.created_at,
       CASE WHEN c.reporter_id IS NOT NULL THEN 'reporter' ELSE 'team' END AS author_kind,
       coalesce(r.login, u.email) AS author_name, r.avatar_url AS author_avatar
     FROM ticket_comments c LEFT JOIN reporters r ON r.id = c.reporter_id LEFT JOIN users u ON u.id = c.user_id
     WHERE c.ticket_id = $1 ORDER BY c.created_at, c.id`,
    [id],
  );
  return { ...ticket, comments };
}

/**
 * A board: `?project_id=` for the reports routed to a project, `?portal_id=` for everything filed on a
 * report page (routed or not). Every open ticket, plus the newest closed ones, in board order.
 */
ticketsRouter.get("/api/tickets", async (req, res) => {
  const column = req.query.project_id ? "t.project_id" : req.query.portal_id ? "t.portal_id" : null;
  const id = Number(req.query.project_id ?? req.query.portal_id);
  if (!column || !Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "Pass project_id or portal_id");
  const tickets = await query(
    `SELECT * FROM (
       SELECT ${TICKET_FIELDS},
         row_number() OVER (PARTITION BY t.status ORDER BY t.closed_at DESC NULLS LAST) AS closed_rank
       FROM tickets t ${TICKET_JOINS} WHERE ${column} = $1
     ) x
     WHERE x.status NOT IN ('done', 'wont_fix') OR x.closed_rank <= $2
     ORDER BY x.position, x.id`,
    [id, CLOSED_COLUMN_LIMIT],
  );
  res.json(tickets.map(({ closed_rank: _, ...t }) => t));
});

ticketsRouter.get("/api/tickets/:id", async (req, res) => {
  const ticket = await ticketDetail(intParam(req, "id"));
  if (!ticket) return notFound(res);
  res.json(ticket);
});

ticketsRouter.patch("/api/tickets/:id", async (req, res) => {
  const id = intParam(req, "id");
  const body = parseBody(
    z.object({
      status: z.enum(TICKET_STATUSES).optional(),
      position: z.number().finite().optional(),
      severity: z.enum(SEVERITIES).optional(),
      title: z.string().trim().min(1).max(200).optional(),
      assignee_id: z.number().int().positive().nullable().optional(),
      /** Routes the ticket to a project (null puts it back in its report page's inbox). */
      project_id: z.number().int().positive().nullable().optional(),
    }),
    req,
  );
  const fields = Object.entries(body).filter(([, v]) => v !== undefined);
  if (!fields.length) throw new HttpError(400, "Nothing to update");
  if (body.assignee_id && !(await one(`SELECT 1 FROM users WHERE id = $1`, [body.assignee_id]))) throw new HttpError(400, "assignee_id: no such team member");
  if (body.project_id && !(await one(`SELECT 1 FROM projects WHERE id = $1`, [body.project_id]))) throw new HttpError(400, "project_id: no such project");
  if (body.project_id === null && !(await one(`SELECT 1 FROM tickets WHERE id = $1 AND portal_id IS NOT NULL`, [id]))) {
    throw new HttpError(400, "project_id: this report has no report page inbox to go back to");
  }

  const params: unknown[] = [id];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const sets = fields.map(([k, v]) => `${k} = ${add(v)}`);
  if (body.status) {
    // Moved to another column without a position: it goes to the top of that column.
    if (body.position === undefined) sets.push(`position = coalesce((SELECT min(position) - 1 FROM tickets WHERE status = ${add(body.status)}), 0)`);
    sets.push(CLOSED_STATUSES.has(body.status) ? `closed_at = coalesce(closed_at, now())` : `closed_at = NULL`);
  }
  const updated = await one(`UPDATE tickets SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 RETURNING id`, params);
  if (!updated) return notFound(res);
  res.json(await ticketDetail(id));
});

ticketsRouter.post("/api/tickets/:id/comments", async (req, res) => {
  const id = intParam(req, "id");
  const body = parseBody(z.object({ body: z.string().trim().min(1).max(10_000), internal: z.boolean().default(false) }), req);
  if (!(await one(`SELECT 1 FROM tickets WHERE id = $1`, [id]))) return notFound(res);
  await query(`INSERT INTO ticket_comments (ticket_id, user_id, body, internal) VALUES ($1, $2, $3, $4)`, [id, req.user!.id, body.body, body.internal]);
  // A reply the reporter can see counts as activity on their ticket.
  if (!body.internal) await query(`UPDATE tickets SET updated_at = now() WHERE id = $1`, [id]);
  res.status(201).json(await ticketDetail(id));
});

ticketsRouter.delete("/api/tickets/:id", async (req, res) => {
  await query(`DELETE FROM tickets WHERE id = $1`, [intParam(req, "id")]);
  res.json({ ok: true });
});

import { randomBytes } from "node:crypto";
import { type Request, Router } from "express";
import { z } from "zod";
import { sendTicketAlert } from "../alerts";
import { createReporterSession, destroyReporterSession, loadReporter, loginRateLimit, type Reporter, requireReporter } from "../auth";
import { config } from "../config";
import { one, query, runInBackground } from "../db";
import { HttpError, intParam, notFound, parseBody } from "./http";
import { SEVERITIES } from "./tickets";

/**
 * The public side of report pages (<APP_URL>/report/:slug). Reporters sign in with GitHub and only ever
 * see the tickets they filed, and the team's non-internal replies to them.
 */
export const portalRouter = Router();

const OAUTH_COOKIE = "bugfree_oauth";
const githubEnabled = () => !!(config.githubClientId && config.githubClientSecret);
function portalUrl(slug: string, query: Record<string, string | undefined> = {}): string {
  const url = new URL(`${config.appUrls[0]}/report/${encodeURIComponent(slug)}`);
  for (const [k, v] of Object.entries(query)) if (v) url.searchParams.set(k, v);
  return url.toString();
}

/** What the sign-in round trip remembers: the CSRF state, which portal to return to, and its `?url=` prefill. */
interface OAuthState {
  state: string;
  slug: string;
  url?: string;
}

interface Portal {
  id: number;
  name: string;
  slug: string;
  intro: string | null;
  ask_project: boolean;
  /** What reporters may see of each project: its id and the page's label for it. */
  projects: Array<{ id: number; label: string }>;
}

async function loadPortal(req: Request): Promise<Portal> {
  const slug = String(req.params.slug ?? req.query.slug ?? "");
  const portal = slug
    ? await one<Portal>(
        `SELECT po.id, po.name, po.slug, po.intro, po.ask_project,
           coalesce((SELECT json_agg(json_build_object('id', p.id, 'label', coalesce(pp.label, p.name)) ORDER BY pp.position, p.name)
                     FROM portal_projects pp JOIN projects p ON p.id = pp.project_id WHERE pp.portal_id = po.id), '[]') AS projects
         FROM portals po WHERE po.slug = $1 AND po.enabled`,
        [slug],
      )
    : undefined;
  if (!portal) throw new HttpError(404, "This bug report page doesn't exist or has been turned off");
  return portal;
}

/** Reporters choose a project only when the page covers several and asks them to. */
const asksForProject = (portal: Portal) => portal.ask_project && portal.projects.length > 1;

// ---- Sign-in ----

/** Starts GitHub sign-in: a top-level navigation from the portal's "Sign in with GitHub" link. */
portalRouter.get("/api/portal/auth/github", async (req, res) => {
  const portal = await loadPortal(req);
  if (!githubEnabled()) throw new HttpError(503, "GitHub sign-in is not configured on this server");
  const state = randomBytes(16).toString("base64url");
  const prefill = typeof req.query.url === "string" && /^https?:\/\//.test(req.query.url) ? req.query.url.slice(0, 2000) : undefined;
  const saved: OAuthState = { state, slug: portal.slug, url: prefill };
  res.cookie(OAUTH_COOKIE, Buffer.from(JSON.stringify(saved)).toString("base64url"), {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    maxAge: 10 * 60_000,
    path: "/api/portal/auth",
  });
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.githubClientId!);
  url.searchParams.set("redirect_uri", `${config.apiUrl}/api/portal/auth/github/callback`);
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "true");
  res.redirect(url.toString());
});

portalRouter.get("/api/portal/auth/github/callback", loginRateLimit, async (req, res) => {
  let saved: OAuthState | undefined;
  try {
    saved = JSON.parse(Buffer.from(String(req.cookies?.[OAUTH_COOKIE] ?? ""), "base64url").toString());
  } catch {}
  res.clearCookie(OAUTH_COOKIE, { path: "/api/portal/auth" });
  if (!saved?.slug || !saved.state) throw new HttpError(400, "Sign-in expired, go back and try again");
  const { state: expected, slug, url } = saved;
  if (req.query.error) return res.redirect(portalUrl(slug, { url, signin: "cancelled" }));
  if (req.query.state !== expected || typeof req.query.code !== "string") throw new HttpError(400, "Sign-in expired, go back and try again");

  let profile;
  try {
    profile = await githubProfile(req.query.code);
  } catch (err) {
    console.error("[portal] GitHub sign-in failed:", err);
    return res.redirect(portalUrl(slug, { url, signin: "failed" }));
  }
  const reporter = await one<{ id: number }>(
    `INSERT INTO reporters (github_id, login, name, avatar_url) VALUES ($1, $2, $3, $4)
     ON CONFLICT (github_id) DO UPDATE SET login = $2, name = $3, avatar_url = $4, last_seen_at = now()
     RETURNING id`,
    [profile.id, profile.login, profile.name, profile.avatar_url],
  );
  await createReporterSession(res, reporter!.id);
  res.redirect(portalUrl(slug, { url }));
});

async function githubProfile(code: string): Promise<{ id: number; login: string; name: string | null; avatar_url: string | null }> {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      code,
      redirect_uri: `${config.apiUrl}/api/portal/auth/github/callback`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!token.access_token) throw new Error(`token exchange: ${token.error_description ?? `HTTP ${tokenRes.status}`}`);
  const userRes = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${token.access_token}`, accept: "application/vnd.github+json", "user-agent": "bugfree" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!userRes.ok) throw new Error(`profile request returned ${userRes.status}`);
  const user = (await userRes.json()) as { id: number; login: string; name?: string | null; avatar_url?: string | null };
  return { id: user.id, login: user.login, name: user.name ?? null, avatar_url: user.avatar_url ?? null };
}

/** Local development only (config.portalDevLogin): signs in a test reporter without a GitHub app. */
portalRouter.post("/api/portal/auth/dev", async (req, res) => {
  if (!config.portalDevLogin) return notFound(res);
  const { login } = parseBody(z.object({ login: z.string().trim().regex(/^[a-z0-9-]{1,39}$/i, "letters, digits and dashes only").default("test-reporter") }), req);
  // Negative ids can't collide with real GitHub accounts.
  const reporter = await one<{ id: number }>(
    `INSERT INTO reporters (github_id, login) VALUES (-(abs(hashtext($1))::bigint + 1), $1)
     ON CONFLICT (github_id) DO UPDATE SET last_seen_at = now() RETURNING id`,
    [login.toLowerCase()],
  );
  await createReporterSession(res, reporter!.id);
  res.json({ ok: true });
});

portalRouter.post("/api/portal/auth/logout", async (req, res) => {
  await destroyReporterSession(req, res);
  res.json({ ok: true });
});

// ---- Report page ----

/** What the page needs to render: its name and projects, who is signed in and how they can sign in. */
portalRouter.get("/api/portal/:slug", async (req, res) => {
  const portal = await loadPortal(req);
  res.json({
    portal: { name: portal.name, slug: portal.slug, intro: portal.intro },
    projects: asksForProject(portal) ? portal.projects : [],
    reporter: (await loadReporter(req)) ?? null,
    signIn: { github: githubEnabled(), dev: config.portalDevLogin },
  });
});

const REPORTER_TICKET_FIELDS = `t.id, t.title, t.severity, t.status, t.created_at, t.updated_at, t.closed_at,
  (SELECT count(*)::int FROM ticket_comments c WHERE c.ticket_id = t.id AND NOT c.internal) AS comment_count`;

portalRouter.get("/api/portal/:slug/tickets", requireReporter, async (req, res) => {
  const portal = await loadPortal(req);
  res.json(
    await query(`SELECT ${REPORTER_TICKET_FIELDS} FROM tickets t WHERE t.portal_id = $1 AND t.reporter_id = $2 ORDER BY t.created_at DESC LIMIT 200`, [
      portal.id,
      req.reporter!.id,
    ]),
  );
});

/** Limits on how much one reporter can file, counted in the database so it holds across API instances. */
async function checkReporterQuota(reporterId: number, table: "tickets" | "ticket_comments", perHour: number): Promise<void> {
  const row = await one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE reporter_id = $1 AND created_at > now() - interval '1 hour'`, [reporterId]);
  if ((row?.n ?? 0) >= perHour) throw new HttpError(429, "You've sent a lot in the last hour. Please try again later.");
}

portalRouter.post("/api/portal/:slug/tickets", requireReporter, async (req, res) => {
  const portal = await loadPortal(req);
  const reporter = req.reporter!;
  const body = parseBody(
    z.object({
      title: z.string().trim().min(3, "must be at least 3 characters").max(200),
      description: z.string().trim().min(1, "tell us what happened").max(10_000),
      page_url: z.union([z.url({ protocol: /^https?$/ }).max(2000), z.literal("")]).optional(),
      severity: z.enum(SEVERITIES).default("normal"),
      /** The reporter's pick among the page's projects; null or missing means "not sure". */
      project_id: z.number().int().positive().nullable().optional(),
    }),
    req,
  );
  // One project: it goes straight there. Several: the reporter's pick, or the page's inbox for the team to route.
  let projectId: number | null = null;
  if (portal.projects.length === 1) projectId = portal.projects[0].id;
  else if (body.project_id && asksForProject(portal)) {
    if (!portal.projects.some((p) => p.id === body.project_id)) throw new HttpError(400, "project_id: not one of this page's projects");
    projectId = body.project_id;
  }
  await checkReporterQuota(reporter.id, "tickets", 10);
  const ticket = await one<{ id: number }>(
    `INSERT INTO tickets (portal_id, project_id, reporter_id, title, description, page_url, user_agent, severity, position)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, coalesce((SELECT min(position) - 1 FROM tickets WHERE status = 'new'), 0))
     RETURNING id`,
    [portal.id, projectId, reporter.id, body.title, body.description, body.page_url || null, req.get("user-agent")?.slice(0, 500) ?? null, body.severity],
  );
  runInBackground(sendTicketAlert(ticket!.id), "ticket alert");
  res.status(201).json(await reporterTicket(portal, reporter, ticket!.id));
});

/**
 * A reporter's own ticket with the visible conversation. Team members are shown as "<page> team", not by
 * email, and the project only by the page's label for it (never a project outside the page).
 */
async function reporterTicket(portal: Portal, reporter: Reporter, id: number) {
  const ticket = await one(
    `SELECT ${REPORTER_TICKET_FIELDS}, t.description, t.page_url, t.project_id FROM tickets t WHERE t.id = $1 AND t.portal_id = $2 AND t.reporter_id = $3`,
    [id, portal.id, reporter.id],
  );
  if (!ticket) return undefined;
  const comments = await query(
    `SELECT c.id, c.body, c.created_at,
       CASE WHEN c.reporter_id IS NOT NULL THEN 'reporter' ELSE 'team' END AS author_kind,
       CASE WHEN c.reporter_id IS NOT NULL THEN r.login ELSE $2 END AS author_name,
       r.avatar_url AS author_avatar
     FROM ticket_comments c LEFT JOIN reporters r ON r.id = c.reporter_id
     WHERE c.ticket_id = $1 AND NOT c.internal ORDER BY c.created_at, c.id`,
    [id, `${portal.name} team`],
  );
  const { project_id, ...rest } = ticket;
  const project = portal.projects.length > 1 ? (portal.projects.find((p) => p.id === project_id)?.label ?? null) : null;
  return { ...rest, project, comments };
}

portalRouter.get("/api/portal/:slug/tickets/:id", requireReporter, async (req, res) => {
  const ticket = await reporterTicket(await loadPortal(req), req.reporter!, intParam(req, "id"));
  if (!ticket) return notFound(res);
  res.json(ticket);
});

portalRouter.post("/api/portal/:slug/tickets/:id/comments", requireReporter, async (req, res) => {
  const portal = await loadPortal(req);
  const id = intParam(req, "id");
  const { body } = parseBody(z.object({ body: z.string().trim().min(1).max(10_000) }), req);
  if (!(await one(`SELECT 1 FROM tickets WHERE id = $1 AND portal_id = $2 AND reporter_id = $3`, [id, portal.id, req.reporter!.id]))) return notFound(res);
  await checkReporterQuota(req.reporter!.id, "ticket_comments", 60);
  await query(`INSERT INTO ticket_comments (ticket_id, reporter_id, body) VALUES ($1, $2, $3)`, [id, req.reporter!.id, body]);
  await query(`UPDATE tickets SET updated_at = now() WHERE id = $1`, [id]);
  res.status(201).json(await reporterTicket(portal, req.reporter!, id));
});

import { randomBytes } from "node:crypto";
import { type Request, Router } from "express";
import { z } from "zod";
import { sendTicketAlert } from "../alerts";
import { createReporterSession, destroyReporterSession, loadReporter, loginRateLimit, type Reporter, requireReporter } from "../auth";
import { config } from "../config";
import { one, query, runInBackground, transaction } from "../db";
import { HttpError, intParam, notFound, parseBody } from "./http";
import { SEVERITIES } from "./tickets";

/**
 * The public bug report portal (<APP_URL>/report/:slug). Reporters sign in with GitHub and only ever
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

interface PortalProject {
  id: number;
  name: string;
  portal_slug: string;
}

async function portalProject(req: Request): Promise<PortalProject> {
  const slug = String(req.params.slug ?? req.query.slug ?? "");
  const project = slug
    ? await one<PortalProject>(`SELECT id, name, portal_slug FROM projects WHERE portal_slug = $1 AND portal_enabled`, [slug])
    : undefined;
  if (!project) throw new HttpError(404, "This bug report page doesn't exist or has been turned off");
  return project;
}

// ---- Sign-in ----

/** Starts GitHub sign-in: a top-level navigation from the portal's "Sign in with GitHub" link. */
portalRouter.get("/api/portal/auth/github", async (req, res) => {
  const project = await portalProject(req);
  if (!githubEnabled()) throw new HttpError(503, "GitHub sign-in is not configured on this server");
  const state = randomBytes(16).toString("base64url");
  const prefill = typeof req.query.url === "string" && /^https?:\/\//.test(req.query.url) ? req.query.url.slice(0, 2000) : undefined;
  const saved: OAuthState = { state, slug: project.portal_slug, url: prefill };
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

// ---- Portal ----

/** What the portal page needs to render: the project, who is signed in and how they can sign in. */
portalRouter.get("/api/portal/:slug", async (req, res) => {
  const project = await portalProject(req);
  res.json({
    project: { name: project.name, slug: project.portal_slug },
    reporter: (await loadReporter(req)) ?? null,
    signIn: { github: githubEnabled(), dev: config.portalDevLogin },
  });
});

const REPORTER_TICKET_FIELDS = `t.number, t.title, t.severity, t.status, t.created_at, t.updated_at, t.closed_at,
  (SELECT count(*)::int FROM ticket_comments c WHERE c.ticket_id = t.id AND NOT c.internal) AS comment_count`;

portalRouter.get("/api/portal/:slug/tickets", requireReporter, async (req, res) => {
  const project = await portalProject(req);
  res.json(
    await query(`SELECT ${REPORTER_TICKET_FIELDS} FROM tickets t WHERE t.project_id = $1 AND t.reporter_id = $2 ORDER BY t.created_at DESC LIMIT 200`, [
      project.id,
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
  const project = await portalProject(req);
  const reporter = req.reporter!;
  const body = parseBody(
    z.object({
      title: z.string().trim().min(3, "must be at least 3 characters").max(200),
      description: z.string().trim().min(1, "tell us what happened").max(10_000),
      page_url: z.union([z.url({ protocol: /^https?$/ }).max(2000), z.literal("")]).optional(),
      severity: z.enum(SEVERITIES).default("normal"),
    }),
    req,
  );
  await checkReporterQuota(reporter.id, "tickets", 10);
  const ticket = await transaction(async (client) => {
    const seq = await one<{ ticket_seq: number }>(`UPDATE projects SET ticket_seq = ticket_seq + 1 WHERE id = $1 RETURNING ticket_seq`, [project.id], client);
    return one<{ number: number }>(
      `INSERT INTO tickets (project_id, number, reporter_id, title, description, page_url, user_agent, severity, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, coalesce((SELECT min(position) - 1 FROM tickets WHERE project_id = $1 AND status = 'new'), 0))
       RETURNING number`,
      [project.id, seq!.ticket_seq, reporter.id, body.title, body.description, body.page_url || null, req.get("user-agent")?.slice(0, 500) ?? null, body.severity],
      client,
    );
  });
  runInBackground(sendTicketAlert(project.id, { number: ticket!.number, title: body.title, severity: body.severity, reporter: reporter.login }), "ticket alert");
  res.status(201).json(await reporterTicket(project, reporter, ticket!.number));
});

/** A reporter's own ticket with the visible conversation. Team members are shown as "<project> team", not by email. */
async function reporterTicket(project: PortalProject, reporter: Reporter, number: number) {
  const ticket = await one(
    `SELECT t.id, ${REPORTER_TICKET_FIELDS}, t.description, t.page_url FROM tickets t WHERE t.project_id = $1 AND t.number = $2 AND t.reporter_id = $3`,
    [project.id, number, reporter.id],
  );
  if (!ticket) return undefined;
  const comments = await query(
    `SELECT c.id, c.body, c.created_at,
       CASE WHEN c.reporter_id IS NOT NULL THEN 'reporter' ELSE 'team' END AS author_kind,
       CASE WHEN c.reporter_id IS NOT NULL THEN r.login ELSE $2 END AS author_name,
       r.avatar_url AS author_avatar
     FROM ticket_comments c LEFT JOIN reporters r ON r.id = c.reporter_id
     WHERE c.ticket_id = $1 AND NOT c.internal ORDER BY c.created_at, c.id`,
    [ticket.id, `${project.name} team`],
  );
  const { id: _, ...rest } = ticket;
  return { ...rest, comments };
}

portalRouter.get("/api/portal/:slug/tickets/:number", requireReporter, async (req, res) => {
  const ticket = await reporterTicket(await portalProject(req), req.reporter!, intParam(req, "number"));
  if (!ticket) return notFound(res);
  res.json(ticket);
});

portalRouter.post("/api/portal/:slug/tickets/:number/comments", requireReporter, async (req, res) => {
  const project = await portalProject(req);
  const number = intParam(req, "number");
  const { body } = parseBody(z.object({ body: z.string().trim().min(1).max(10_000) }), req);
  const ticket = await one<{ id: number }>(`SELECT id FROM tickets WHERE project_id = $1 AND number = $2 AND reporter_id = $3`, [
    project.id,
    number,
    req.reporter!.id,
  ]);
  if (!ticket) return notFound(res);
  await checkReporterQuota(req.reporter!.id, "ticket_comments", 60);
  await query(`INSERT INTO ticket_comments (ticket_id, reporter_id, body) VALUES ($1, $2, $3)`, [ticket.id, req.reporter!.id, body]);
  await query(`UPDATE tickets SET updated_at = now() WHERE id = $1`, [ticket.id]);
  res.status(201).json(await reporterTicket(project, req.reporter!, number));
});

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config";
import { one, query, runInBackground } from "./db";

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
export const SESSION_COOKIE = "bugfree_session";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, keyB64] = stored.split("$");
  if (algo !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function randomKey(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

export async function createSession(res: Response, userId: number): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + config.sessionDays * 86_400_000);
  await query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`, [sha256(token), userId, expires]);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    domain: config.cookieDomain,
    expires,
    path: "/",
  });
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await query(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(token)]);
  res.clearCookie(SESSION_COOKIE, { domain: config.cookieDomain, path: "/" });
}

export interface AuthedUser {
  id: number;
  email: string;
  /** Set for requests authenticated with a read-only API token. */
  readOnly?: boolean;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthedUser;
  }
}

export async function loadUser(req: Request): Promise<AuthedUser | undefined> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return undefined;
  return one<AuthedUser>(
    `SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await loadUser(req);
  if (!user) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  req.user = user;
  next();
}

// ---- Bug reporters (portal) ----
// Reporters are not team members: their own table, session table and cookie, so a reporter
// session can never pass requireAuth.

export const REPORTER_COOKIE = "bugfree_reporter";

export interface Reporter {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

declare module "express-serve-static-core" {
  interface Request {
    reporter?: Reporter;
  }
}

export async function createReporterSession(res: Response, reporterId: number): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + config.sessionDays * 86_400_000);
  await query(`INSERT INTO reporter_sessions (token_hash, reporter_id, expires_at) VALUES ($1, $2, $3)`, [sha256(token), reporterId, expires]);
  res.cookie(REPORTER_COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    domain: config.cookieDomain,
    expires,
    path: "/",
  });
}

export async function destroyReporterSession(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[REPORTER_COOKIE];
  if (token) await query(`DELETE FROM reporter_sessions WHERE token_hash = $1`, [sha256(token)]);
  res.clearCookie(REPORTER_COOKIE, { domain: config.cookieDomain, path: "/" });
}

export async function loadReporter(req: Request): Promise<Reporter | undefined> {
  const token = req.cookies?.[REPORTER_COOKIE];
  if (!token) return undefined;
  return one<Reporter>(
    `SELECT r.id, r.login, r.name, r.avatar_url FROM reporter_sessions s JOIN reporters r ON r.id = s.reporter_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
}

export async function requireReporter(req: Request, res: Response, next: NextFunction): Promise<void> {
  const reporter = await loadReporter(req);
  if (!reporter) {
    res.status(401).json({ error: "Sign in to report bugs" });
    return;
  }
  req.reporter = reporter;
  next();
}

// ---- Personal API tokens (MCP clients) ----

const API_TOKEN_PREFIX = "bfu_";

export async function createApiToken(userId: number, name: string, readOnly: boolean) {
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const row = await one<{ id: number; name: string; prefix: string; read_only: boolean; last_used_at: Date | null; created_at: Date }>(
    `INSERT INTO api_tokens (user_id, name, token_hash, prefix, read_only) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, prefix, read_only, last_used_at, created_at`,
    [userId, name, sha256(token), token.slice(0, API_TOKEN_PREFIX.length + 6), readOnly],
  );
  return { ...row!, token };
}

/** The user behind an `Authorization: Bearer bfu_…` header, if the token is valid. */
export async function loadTokenUser(req: Request): Promise<AuthedUser | undefined> {
  const token = (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token.startsWith(API_TOKEN_PREFIX)) return undefined;
  const user = await one<AuthedUser & { token_id: number; read_only: boolean; last_used_at: Date | null }>(
    `SELECT u.id, u.email, t.id AS token_id, t.read_only, t.last_used_at FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1`,
    [sha256(token)],
  );
  if (!user) return undefined;
  // Coarse last-used tracking: at most one write per token per minute.
  if (!user.last_used_at || Date.now() - user.last_used_at.getTime() > 60_000) {
    runInBackground(query(`UPDATE api_tokens SET last_used_at = now() WHERE id = $1`, [user.token_id]), "api tokens");
  }
  return { id: user.id, email: user.email, readOnly: user.read_only };
}

/** Rejects cross-site writes: state-changing requests must come from a dashboard origin. */
export function checkOrigin(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const origin = req.get("origin");
  if (!origin || !config.appUrls.includes(origin)) {
    res.status(403).json({ error: "Cross-origin request rejected" });
    return;
  }
  next();
}

/** Small in-memory limiter for login attempts per IP. */
const attempts = new Map<string, { count: number; reset: number }>();
export function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = req.ip ?? "unknown";
  const now = Date.now();
  // Drop expired windows so IPs that tried once don't stay in memory forever.
  if (attempts.size > 1000) for (const [k, e] of attempts) if (e.reset < now) attempts.delete(k);
  const entry = attempts.get(key);
  if (!entry || entry.reset < now) {
    attempts.set(key, { count: 1, reset: now + 15 * 60_000 });
    return next();
  }
  if (++entry.count > 20) {
    res.status(429).json({ error: "Too many attempts, try again later" });
    return;
  }
  next();
}

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config";
import { one, query } from "./db";

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

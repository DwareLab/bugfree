import { Router } from "express";
import { z } from "zod";
import { createSession, destroySession, hashPassword, loadUser, loginRateLimit, requireAuth, verifyPassword } from "../auth";
import { one, query } from "../db";
import { HttpError, intParam, parseBody } from "./http";

export const authRouter = Router();

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8, "must be at least 8 characters").max(200),
});

/** Whether first-run setup is needed, and who is signed in. */
authRouter.get("/api/auth/state", async (req, res) => {
  const count = await one<{ n: number }>("SELECT count(*)::int AS n FROM users");
  const user = await loadUser(req);
  res.json({ setupRequired: count?.n === 0, user: user ?? null });
});

/** Creates the first account. Only works while there are no users. */
authRouter.post("/api/auth/setup", loginRateLimit, async (req, res) => {
  const { email, password } = parseBody(credentials, req);
  const hash = await hashPassword(password);
  const user = await one<{ id: number; email: string }>(
    `INSERT INTO users (email, password_hash) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM users) RETURNING id, email`,
    [email, hash],
  );
  if (!user) throw new HttpError(409, "Setup has already been completed");
  await createSession(res, user.id);
  res.status(201).json({ user });
});

authRouter.post("/api/auth/login", loginRateLimit, async (req, res) => {
  const { email, password } = parseBody(credentials.extend({ password: z.string().min(1).max(200) }), req);
  const row = await one<{ id: number; email: string; password_hash: string }>(`SELECT id, email, password_hash FROM users WHERE email = $1`, [email]);
  if (!row || !(await verifyPassword(password, row.password_hash))) throw new HttpError(401, "Wrong email or password");
  await createSession(res, row.id);
  res.json({ user: { id: row.id, email: row.email } });
});

authRouter.post("/api/auth/logout", async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

authRouter.post("/api/auth/password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = parseBody(
    z.object({ currentPassword: z.string().min(1), newPassword: credentials.shape.password }),
    req,
  );
  const row = await one<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [req.user!.id]);
  if (!row || !(await verifyPassword(currentPassword, row.password_hash))) throw new HttpError(400, "Current password is wrong");
  await query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [req.user!.id, await hashPassword(newPassword)]);
  res.json({ ok: true });
});

// Team members: everyone has full access (single-team install).
authRouter.get("/api/users", requireAuth, async (_req, res) => {
  res.json(await query(`SELECT id, email, created_at FROM users ORDER BY created_at`));
});

authRouter.post("/api/users", requireAuth, async (req, res) => {
  const { email, password } = parseBody(credentials, req);
  const user = await one(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id, email, created_at`,
    [email, await hashPassword(password)],
  );
  if (!user) throw new HttpError(409, "A user with that email already exists");
  res.status(201).json(user);
});

authRouter.delete("/api/users/:id", requireAuth, async (req, res) => {
  const id = intParam(req, "id");
  if (id === req.user!.id) throw new HttpError(400, "You can't remove yourself");
  await query(`DELETE FROM users WHERE id = $1`, [id]);
  res.json({ ok: true });
});

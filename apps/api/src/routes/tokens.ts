import { Router } from "express";
import { z } from "zod";
import { createApiToken, requireAuth } from "../auth";
import { query } from "../db";
import { intParam, parseBody } from "./http";

/** Personal API tokens of the signed-in user, for MCP clients. */
export const tokensRouter = Router();
tokensRouter.use("/api/tokens", requireAuth);

tokensRouter.get("/api/tokens", async (req, res) => {
  res.json(
    await query(`SELECT id, name, prefix, read_only, last_used_at, created_at FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC`, [req.user!.id]),
  );
});

/** The token itself is only in this response. */
tokensRouter.post("/api/tokens", async (req, res) => {
  const body = parseBody(z.object({ name: z.string().trim().min(1).max(100), read_only: z.boolean().default(false) }), req);
  res.status(201).json(await createApiToken(req.user!.id, body.name, body.read_only));
});

tokensRouter.delete("/api/tokens/:id", async (req, res) => {
  await query(`DELETE FROM api_tokens WHERE id = $1 AND user_id = $2`, [intParam(req, "id"), req.user!.id]);
  res.json({ ok: true });
});

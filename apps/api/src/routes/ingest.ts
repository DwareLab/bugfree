import express, { type Request, type Response, Router } from "express";
import { config } from "../config";
import { one } from "../db";
import { processEvent } from "../ingest/process";
import { eventSchema } from "../ingest/schema";

export const ingestRouter = Router();

// SDKs post from any origin without credentials; the public key is the only auth (like a Sentry DSN).
function ingestCors(req: Request, res: Response, next: () => void): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-bugfree-key");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

const keyCache = new Map<number, { key: string | null; at: number }>();
const KEY_TTL_MS = 60_000;

export function forgetProjectKey(projectId: number): void {
  keyCache.delete(projectId);
}

async function projectKey(projectId: number): Promise<string | null> {
  const cached = keyCache.get(projectId);
  if (cached && Date.now() - cached.at < KEY_TTL_MS) return cached.key;
  const row = await one<{ public_key: string }>("SELECT public_key FROM projects WHERE id = $1", [projectId]);
  const key = row?.public_key ?? null;
  keyCache.set(projectId, { key, at: Date.now() });
  return key;
}

// Token bucket per project: `rate` events/s sustained, bursts up to 10x.
const buckets = new Map<number, { tokens: number; at: number }>();
function allow(projectId: number): boolean {
  const rate = config.ingestRateLimit;
  const capacity = rate * 10;
  const now = Date.now();
  const b = buckets.get(projectId) ?? { tokens: capacity, at: now };
  b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * rate);
  b.at = now;
  buckets.set(projectId, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

ingestRouter.options("/api/ingest/:projectId", ingestCors);
ingestRouter.post(
  "/api/ingest/:projectId",
  ingestCors,
  // Browsers send text/plain to avoid a CORS preflight; parse every body as text and JSON.parse it ourselves.
  express.text({ type: () => true, limit: "1mb" }),
  async (req, res) => {
    const projectId = Number(req.params.projectId);
    const key = String(req.query.key ?? req.get("x-bugfree-key") ?? "");
    if (!Number.isSafeInteger(projectId) || !key) {
      res.status(401).json({ error: "Missing project id or key" });
      return;
    }
    const expected = await projectKey(projectId);
    if (!expected || expected !== key) {
      res.status(401).json({ error: "Invalid project or key" });
      return;
    }
    if (!allow(projectId)) {
      res.setHeader("Retry-After", "10");
      res.status(429).json({ error: "Rate limit exceeded" });
      return;
    }
    let body: unknown;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
      res.status(400).json({ error: "Body must be JSON" });
      return;
    }
    const parsed = eventSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid event", issues: parsed.error.issues.slice(0, 10) });
      return;
    }
    const result = await processEvent(projectId, parsed.data, req.ip);
    res.json({ id: result.eventId, issue_id: result.issueId || undefined });
  },
);

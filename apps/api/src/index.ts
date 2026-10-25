import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import { checkOrigin } from "./auth";
import { config } from "./config";
import { migrate, pool, query } from "./db";
import { authRouter } from "./routes/auth";
import { HttpError } from "./routes/http";
import { ingestRouter } from "./routes/ingest";
import { issuesRouter } from "./routes/issues";
import { projectsRouter } from "./routes/projects";
import { cliRouter, releasesRouter } from "./routes/releases";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);

  app.get("/healthz", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  });

  // SDK + CLI endpoints: their own CORS / auth, no dashboard session.
  app.use(ingestRouter, cliRouter);

  // Dashboard API: credentialed CORS for the dashboard origin(s) only, and an Origin check on writes.
  app.use("/api", dashboardCors, checkOrigin, cookieParser(), express.json({ limit: "1mb" }));
  app.use(authRouter, projectsRouter, issuesRouter, releasesRouter);

  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    const status = (err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: (err as Error).message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

function dashboardCors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get("origin");
  if (origin && config.appUrls.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", req.get("access-control-request-headers") ?? "content-type");
      res.setHeader("Access-Control-Max-Age", "600");
      res.status(204).end();
      return;
    }
  } else if (req.method === "OPTIONS") {
    res.status(403).end();
    return;
  }
  next();
}

/** Deletes events past the retention window (issue counters and hourly stats are kept). */
async function runRetention(): Promise<void> {
  try {
    let deleted = 0;
    for (;;) {
      const rows = await query(
        `DELETE FROM events WHERE id IN (SELECT id FROM events WHERE received_at < now() - make_interval(days => $1) LIMIT 5000) RETURNING 1`,
        [config.retentionDays],
      );
      deleted += rows.length;
      if (rows.length < 5000) break;
    }
    await query(`DELETE FROM sessions WHERE expires_at < now()`);
    await query(`DELETE FROM issue_hourly WHERE hour < now() - interval '90 days'`);
    if (deleted) console.log(`[retention] deleted ${deleted} events older than ${config.retentionDays} days`);
  } catch (err) {
    console.error("[retention] failed:", err);
  }
}

async function main(): Promise<void> {
  await migrate();
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[api] listening on :${config.port} (API_URL=${config.apiUrl}, APP_URL=${config.appUrls.join(",")})`);
  });
  void runRetention();
  const timer = setInterval(runRetention, 60 * 60_000);
  const shutdown = () => {
    clearInterval(timer);
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

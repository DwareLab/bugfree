import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import { checkOrigin } from "./auth";
import { config } from "./config";
import { getPool } from "./db";
import { mcpRouter } from "./mcp/server";
import { authRouter } from "./routes/auth";
import { HttpError } from "./routes/http";
import { ingestRouter } from "./routes/ingest";
import { issuesRouter } from "./routes/issues";
import { logsIngestRouter, logsRouter } from "./routes/logs";
import { projectsRouter } from "./routes/projects";
import { cliRouter, releasesRouter } from "./routes/releases";
import { tokensRouter } from "./routes/tokens";

/** The Express app, shared by the Node.js server (index.ts) and the Cloudflare Worker (worker.ts). */
export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);

  app.get("/healthz", async (_req, res) => {
    await getPool().query("SELECT 1");
    res.json({ ok: true });
  });

  // SDK, log agent, CLI and MCP endpoints: their own CORS / auth, no dashboard session.
  app.use(ingestRouter, logsIngestRouter, cliRouter, mcpRouter);

  // Dashboard API: credentialed CORS for the dashboard origin(s) only, and an Origin check on writes.
  app.use("/api", dashboardCors, checkOrigin, cookieParser(), express.json({ limit: "1mb" }));
  app.use(authRouter, projectsRouter, issuesRouter, logsRouter, releasesRouter, tokensRouter);

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

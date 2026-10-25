// Cloudflare Workers entry (wrangler.json). The Node.js / Docker entry is index.ts.
// Vars and secrets from wrangler.json reach config.ts through process.env (nodejs_compat).
import { httpServerHandler } from "cloudflare:node";
import pg from "pg";
import { createApp } from "./app";
import { migrate, type RequestScope, settleBackground, withRequestScope } from "./db";
import { runRetention } from "./retention";
import { migrations } from "./worker-migrations";

// Express listens on a virtual port; httpServerHandler routes the Worker's requests to it.
const PORT = 8080;
createApp().listen(PORT);
const server = httpServerHandler({ port: PORT });

// Set once this isolate has seen the schema up to date. Concurrent cold requests may both check;
// migrate()'s advisory lock serializes them.
let migrated = false;

interface Env {
  /** Hyperdrive config in front of Postgres (query caching off: the dashboard needs fresh reads). */
  HYPERDRIVE: { connectionString: string };
}

/** Workers can't reuse sockets across requests, so each invocation gets its own pool (Hyperdrive pools the real connections). */
function newScope(env: Env): RequestScope {
  return { pool: new pg.Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 5 }), tasks: [] };
}

async function closeScope(scope: RequestScope): Promise<void> {
  await settleBackground(scope);
  await scope.pool.end();
}

async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  await migrate(migrations);
  migrated = true;
}

/** req.ip comes from Cloudflare's CF-Connecting-IP, never from a client-sent X-Forwarded-For. */
function withClientIp(request: Request): Request {
  const headers = new Headers(request.headers);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) headers.set("x-forwarded-for", ip);
  else headers.delete("x-forwarded-for");
  headers.set("x-forwarded-proto", new URL(request.url).protocol.replace(":", ""));
  return new Request(request, { headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const scope = newScope(env);
    let response: Response;
    try {
      response = await withRequestScope(scope, async () => {
        await ensureMigrated();
        return server.fetch(withClientIp(request), env, ctx);
      });
    } catch (err) {
      ctx.waitUntil(closeScope(scope));
      throw err;
    }
    if (!response.body) {
      ctx.waitUntil(closeScope(scope));
      return response;
    }
    // A streamed body (MCP over SSE) can still be querying after the headers are sent:
    // close the pool once Express has written the last byte.
    const { readable, writable } = new TransformStream();
    ctx.waitUntil(
      response.body
        .pipeTo(writable)
        .catch(() => {})
        .then(() => closeScope(scope)),
    );
    return new Response(readable, response);
  },

  /** Cron trigger (wrangler.json): the hourly retention job that index.ts runs on a timer. */
  async scheduled(_controller: unknown, env: Env, _ctx: ExecutionContext): Promise<void> {
    const scope = newScope(env);
    try {
      await withRequestScope(scope, async () => {
        await ensureMigrated();
        await runRetention();
      });
    } finally {
      await closeScope(scope);
    }
  },
};

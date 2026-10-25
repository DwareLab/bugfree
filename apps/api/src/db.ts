import { AsyncLocalStorage } from "node:async_hooks";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "./config";

// bigint ids/counts as JS numbers (safe up to 2^53).
pg.types.setTypeParser(20, (v) => Number(v));

/**
 * Per-invocation state on Cloudflare Workers (worker.ts), which can't share sockets between requests:
 * the invocation's own pool, and the background tasks to finish before that pool closes.
 */
export interface RequestScope {
  pool: pg.Pool;
  tasks: Promise<unknown>[];
}

const requestScope = new AsyncLocalStorage<RequestScope>();
let sharedPool: pg.Pool | undefined;

/** The current Worker invocation's pool, or the process-wide pool on Node.js. */
export function getPool(): pg.Pool {
  return requestScope.getStore()?.pool ?? (sharedPool ??= new pg.Pool({ connectionString: config.databaseUrl, max: 20 }));
}

export function withRequestScope<T>(scope: RequestScope, fn: () => Promise<T>): Promise<T> {
  return requestScope.run(scope, fn);
}

/** Fire-and-forget work (alerts, bookkeeping). On Workers it's awaited before the invocation's pool closes. */
export function runInBackground(task: Promise<unknown>, label: string): void {
  const settled = task.catch((err) => console.error(`[${label}] failed:`, err));
  requestScope.getStore()?.tasks.push(settled);
}

export async function settleBackground(scope: RequestScope): Promise<void> {
  // Tasks can start more tasks.
  while (scope.tasks.length) await Promise.all(scope.tasks.splice(0));
}

export type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export async function query<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = [], db: Queryable = getPool()): Promise<T[]> {
  const res = await db.query<T>(sql, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = [], db: Queryable = getPool()): Promise<T | undefined> {
  return (await query<T>(sql, params, db))[0];
}

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface Migration {
  name: string;
  sql: string;
}

/** migrations/*.sql in name order. Workers have no filesystem and pass worker-migrations.ts instead. */
async function migrationFiles(): Promise<Migration[]> {
  // src/db.ts in dev, dist/index.js when built: migrations/ sits next to both parents.
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const names = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(names.map(async (name) => ({ name, sql: await fs.readFile(path.join(dir, name), "utf8") })));
}

/** Applies pending migrations in name order, each in its own transaction. */
export async function migrate(migrations?: Migration[]): Promise<void> {
  await getPool().query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set((await query<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
  const pending = (migrations ?? (await migrationFiles())).filter((m) => !applied.has(m.name));
  for (const { name, sql } of pending) {
    await transaction(async (client) => {
      // Serialize concurrent API instances starting at once.
      await client.query("SELECT pg_advisory_xact_lock(726354)");
      const done = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
      if (done.rowCount) return;
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
    });
    console.log(`[db] applied migration ${name}`);
  }
}

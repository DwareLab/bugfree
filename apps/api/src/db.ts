import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "./config";

// bigint ids/counts as JS numbers (safe up to 2^53).
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });

export type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export async function query<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = [], db: Queryable = pool): Promise<T[]> {
  const res = await db.query<T>(sql, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = [], db: Queryable = pool): Promise<T | undefined> {
  return (await query<T>(sql, params, db))[0];
}

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
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

function migrationsDir(): string {
  // src/db.ts in dev, dist/index.js when built: migrations/ sits next to both parents.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "migrations");
}

/** Applies pending migrations/*.sql in name order, each in its own transaction. */
export async function migrate(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const dir = migrationsDir();
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set((await query<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(dir, file), "utf8");
    await transaction(async (client) => {
      // Serialize concurrent API instances starting at once.
      await client.query("SELECT pg_advisory_xact_lock(726354)");
      const done = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (done.rowCount) return;
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    });
    console.log(`[db] applied migration ${file}`);
  }
}

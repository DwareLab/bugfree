import { config } from "./config";
import { query } from "./db";

async function deleteInBatches(sql: string, params: unknown[]): Promise<number> {
  let deleted = 0;
  for (;;) {
    const rows = await query(sql, params);
    deleted += rows.length;
    if (rows.length < 5000) return deleted;
  }
}

/**
 * Deletes events, logs and idle releases' source maps past their retention windows (issue counters and hourly stats are kept).
 * Runs hourly: on a timer in index.ts, from a Cron Trigger in worker.ts.
 */
export async function runRetention(): Promise<void> {
  try {
    const deleted = await deleteInBatches(
      `DELETE FROM events WHERE id IN (SELECT id FROM events WHERE received_at < now() - make_interval(days => $1) LIMIT 5000) RETURNING 1`,
      [config.retentionDays],
    );
    const deletedLogs = await deleteInBatches(
      `DELETE FROM logs WHERE id IN (SELECT id FROM logs WHERE received_at < now() - make_interval(days => $1) LIMIT 5000) RETURNING 1`,
      [config.logRetentionDays],
    );
    const artifacts = await query<{ size: number }>(
      `DELETE FROM artifacts a USING releases r
       WHERE a.release_id = r.id
         AND r.id NOT IN (
           SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY created_at DESC) AS rank FROM releases) newest
           WHERE rank <= $2)
         AND r.created_at < now() - make_interval(days => $1)
         AND NOT EXISTS (SELECT 1 FROM artifacts recent WHERE recent.release_id = r.id AND recent.created_at >= now() - make_interval(days => $1))
         -- issue_tags outlives event retention, so it still knows when a release last had an event.
         AND NOT EXISTS (
           SELECT 1 FROM issue_tags t JOIN issues i ON i.id = t.issue_id
           WHERE t.key = 'release' AND t.value = left(r.version, 200) AND i.project_id = r.project_id
             AND t.last_seen >= now() - make_interval(days => $1))
       RETURNING a.size`,
      [config.artifactRetentionDays, config.artifactKeepReleases],
    );
    await query(`DELETE FROM sessions WHERE expires_at < now()`);
    await query(`DELETE FROM issue_hourly WHERE hour < now() - interval '90 days'`);
    if (deleted) console.log(`[retention] deleted ${deleted} events older than ${config.retentionDays} days`);
    if (artifacts.length) {
      const mb = (artifacts.reduce((n, a) => n + a.size, 0) / 1e6).toFixed(1);
      console.log(`[retention] deleted ${artifacts.length} source maps (${mb} MB) of releases idle for ${config.artifactRetentionDays} days`);
    }
    if (deletedLogs) console.log(`[retention] deleted ${deletedLogs} log lines older than ${config.logRetentionDays} days`);
  } catch (err) {
    console.error("[retention] failed:", err);
  }
}

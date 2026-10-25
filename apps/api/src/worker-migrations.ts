// Workers have no filesystem, so the Worker bundles each migration (Wrangler imports .sql files as strings).
// Add new migrations here too; test/worker-migrations.test.ts checks the list.
import m001 from "../migrations/001_init.sql";
import m002 from "../migrations/002_api_tokens.sql";
import m003 from "../migrations/003_logs.sql";
import m004 from "../migrations/004_api_token_scope.sql";
import type { Migration } from "./db";

export const migrations: Migration[] = [
  { name: "001_init.sql", sql: m001 },
  { name: "002_api_tokens.sql", sql: m002 },
  { name: "003_logs.sql", sql: m003 },
  { name: "004_api_token_scope.sql", sql: m004 },
];

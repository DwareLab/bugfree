// Node.js entry (Docker, `npm run dev:api`). The Cloudflare Workers entry is worker.ts.
import { createApp } from "./app";
import { config } from "./config";
import { getPool, migrate } from "./db";
import { closeMcp } from "./mcp/server";
import { runRetention } from "./retention";

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
    void closeMcp();
    server.close(() => getPool().end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

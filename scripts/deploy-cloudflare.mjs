#!/usr/bin/env node
// Deploys bugfree to Cloudflare: the API as a Worker that reaches your Postgres through Hyperdrive, and the
// dashboard as a Worker built with OpenNext. Safe to re-run: it's also how you upgrade. See --help.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const HELP = `Deploy bugfree to Cloudflare Workers.

Usage:
  DATABASE_URL=postgres://… npm run deploy:cloudflare -- [options]

Options:
  --domain <domain>     A domain on your Cloudflare account. Serves the dashboard on app.<domain>
                        and the API on api.<domain>. Without it, both get workers.dev URLs.
  --app-host <host>     Dashboard hostname instead of app.<domain>
  --api-host <host>     API hostname instead of api.<domain>
  --name <prefix>       Worker name prefix (default "bugfree": bugfree-api, bugfree-web)
  --only <api|web>      Deploy just one of the two Workers
  -h, --help            Show this help

Environment:
  DATABASE_URL          Postgres connection string. Needed on the first deploy (it creates the
                        Hyperdrive config); later deploys reuse the saved Hyperdrive id.
  HYPERDRIVE_ID         Use an existing Hyperdrive config instead (e.g. in CI)
  SMTP_URL              Stored as a Worker secret to enable email alerts (port 465 or 587)
  ALERT_FROM, RETENTION_DAYS, LOG_RETENTION_DAYS, ARTIFACT_RETENTION_DAYS, ARTIFACT_KEEP_RELEASES,
  SESSION_DAYS, INGEST_RATE_LIMIT, LOG_RATE_LIMIT
                        Passed to the API when set
  CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
                        For CI; locally the script runs \`wrangler login\` if needed

Settings from the last run are saved in .cloudflare.json (gitignored) and reused.`;

const ROOT = path.resolve(import.meta.dirname, "..");
const API_DIR = path.join(ROOT, "apps/api");
const WEB_DIR = path.join(ROOT, "apps/web");
const STATE_FILE = path.join(ROOT, ".cloudflare.json");
const PASSTHROUGH_VARS = [
  "ALERT_FROM",
  "RETENTION_DAYS",
  "LOG_RETENTION_DAYS",
  "ARTIFACT_RETENTION_DAYS",
  "ARTIFACT_KEEP_RELEASES",
  "SESSION_DAYS",
  "INGEST_RATE_LIMIT",
  "LOG_RATE_LIMIT",
];

const { values: args } = parseArgs({
  options: {
    domain: { type: "string" },
    "app-host": { type: "string" },
    "api-host": { type: "string" },
    name: { type: "string" },
    only: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (args.only && !["api", "web"].includes(args.only)) fail(`--only must be "api" or "web"`);

const tmp = mkdtempSync(path.join(os.tmpdir(), "bugfree-deploy-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const saveState = () => writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);

const name = args.name ?? state.name ?? "bugfree";
const domain = args.domain ?? state.domain;
const apiHost = args["api-host"] ?? (args.domain ? `api.${args.domain}` : state.apiHost);
const appHost = args["app-host"] ?? (args.domain ? `app.${args.domain}` : state.appHost);
if (Boolean(apiHost) !== Boolean(appHost)) fail("Pass --domain, or both --app-host and --api-host");
Object.assign(state, { name, domain, apiHost, appHost });

step("Checking Cloudflare login");
ensureLoggedIn();

// URLs: custom hostnames are known up front; workers.dev ones only after the first deploy.
let apiUrl = apiHost ? `https://${apiHost}` : state.workersDev?.apiUrl;
let appUrl = appHost ? `https://${appHost}` : state.workersDev?.appUrl;

if (args.only !== "web") {
  const hyperdriveId = process.env.HYPERDRIVE_ID || ensureHyperdrive();
  const targets = deployApi(hyperdriveId);
  if (!apiHost) {
    const url = targets.find((t) => t.endsWith(".workers.dev"));
    if (!url) fail("Couldn't read the API's workers.dev URL from wrangler's output. Pass --domain instead.");
    const urls = { apiUrl: url, appUrl: url.replace(`//${name}-api.`, `//${name}-web.`) };
    if (urls.apiUrl !== apiUrl || urls.appUrl !== appUrl) {
      ({ apiUrl, appUrl } = urls);
      step("Redeploying the API with its workers.dev URLs");
      deployApi(hyperdriveId);
    }
    state.workersDev = urls;
  }
  saveState();
  if (process.env.SMTP_URL) {
    step("Storing SMTP_URL as a secret");
    wrangler(["secret", "put", "SMTP_URL", "--config", "wrangler.deploy.json"], { cwd: API_DIR, input: process.env.SMTP_URL });
  }
}

if (args.only !== "api") {
  if (!apiUrl) fail("The API URL is unknown: deploy the API first (run without --only web).");
  deployWeb();
  saveState();
}

if (args.only !== "web") {
  step("Checking the API (applies database migrations on first start)");
  await checkHealth(`${apiUrl}/healthz`);
}

console.log(`
✔ bugfree is deployed

  Dashboard  ${appUrl}
  API / DSN  ${apiUrl}
  MCP        ${apiUrl}/mcp

Open the dashboard to create the admin account, then create a project.
Re-run this command to upgrade after pulling a new version.`);

// ---------------------------------------------------------------------------

function ensureHyperdrive() {
  if (state.hyperdriveId) return state.hyperdriveId;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    fail(
      "Set DATABASE_URL to your Postgres connection string for the first deploy, e.g.\n" +
        "  DATABASE_URL='postgres://user:pass@host:5432/bugfree?sslmode=require' npm run deploy:cloudflare",
    );
  }
  step(`Creating the Hyperdrive config "${name}-db" (query caching off: the dashboard needs fresh reads)`);
  const out = wrangler(["hyperdrive", "create", `${name}-db`, `--connection-string=${databaseUrl}`, "--caching-disabled"], { capture: true });
  const id = out.match(/\b[0-9a-f]{32}\b/)?.[0];
  if (!id) fail("Couldn't find the new Hyperdrive id in wrangler's output. Create it yourself and pass HYPERDRIVE_ID.");
  console.log(`  Hyperdrive id: ${id}`);
  state.hyperdriveId = id;
  saveState();
  return id;
}

function deployApi(hyperdriveId) {
  step(`Deploying the API (${name}-api)`);
  const base = readJson(path.join(API_DIR, "wrangler.json"));
  const vars = {
    ...base.vars,
    API_URL: apiUrl ?? "https://pending.invalid",
    APP_URL: appUrl ?? "https://pending.invalid",
    COOKIE_SECURE: "true",
  };
  // With custom hostnames the cookie is shared by the parent domain; on workers.dev it stays on the API host.
  if (apiHost && domain) vars.COOKIE_DOMAIN = `.${domain}`;
  for (const key of PASSTHROUGH_VARS) if (process.env[key]) vars[key] = process.env[key];
  const config = {
    ...base,
    name: `${name}-api`,
    hyperdrive: [{ binding: "HYPERDRIVE", id: hyperdriveId }],
    vars,
    // Kept on next to a custom domain so DSNs from a workers.dev setup keep working.
    workers_dev: true,
    ...(apiHost ? { routes: [{ pattern: apiHost, custom_domain: true }] } : {}),
  };
  return deploy(API_DIR, config, ["npx", "wrangler", "deploy", "--config", "wrangler.deploy.json"]);
}

function deployWeb() {
  step(`Building and deploying the dashboard (${name}-web) against ${apiUrl}`);
  const base = readJson(path.join(WEB_DIR, "wrangler.json"));
  const config = {
    ...base,
    name: `${name}-web`,
    services: [{ binding: "WORKER_SELF_REFERENCE", service: `${name}-web` }],
    workers_dev: true,
    ...(appHost ? { routes: [{ pattern: appHost, custom_domain: true }] } : {}),
  };
  const env = { NEXT_PUBLIC_API_URL: apiUrl };
  writeConfig(WEB_DIR, config);
  run("npx", ["opennextjs-cloudflare", "build", "--config", "wrangler.deploy.json"], { cwd: WEB_DIR, env });
  return deploy(WEB_DIR, config, ["npx", "opennextjs-cloudflare", "deploy", "--config", "wrangler.deploy.json"], env);
}

/** Writes the generated config next to the committed one and runs the deploy, returning the URLs it deployed to. */
function deploy(dir, config, [cmd, ...cmdArgs], env = {}) {
  writeConfig(dir, config);
  const outputFile = path.join(tmp, `${config.name}-${Date.now()}.ndjson`);
  run(cmd, cmdArgs, { cwd: dir, env: { NODE_ENV: "production", WRANGLER_OUTPUT_FILE_PATH: outputFile, ...env } });
  if (!existsSync(outputFile)) return [];
  return readFileSync(outputFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "deploy")
    .flatMap((entry) => entry.targets ?? [])
    .map((t) => (t.startsWith("http") ? t : `https://${t}`));
}

function writeConfig(dir, config) {
  writeFileSync(path.join(dir, "wrangler.deploy.json"), `${JSON.stringify(config, null, 2)}\n`);
}

function ensureLoggedIn() {
  if (process.env.CLOUDFLARE_API_TOKEN) return;
  const res = spawnSync("npx", ["wrangler", "whoami"], { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" });
  if (res.status === 0 && !/not authenticated/i.test(`${res.stdout}${res.stderr}`)) return;
  wrangler(["login"]);
}

async function checkHealth(url) {
  // A new custom domain can take a minute or two to get its certificate.
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) return console.log(`  ${url} → ok`);
      console.log(`  ${url} → HTTP ${res.status} (attempt ${attempt}/12)`);
    } catch (err) {
      console.log(`  ${url} → ${err.cause?.code ?? err.message} (attempt ${attempt}/12)`);
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.log(`  The API isn't answering yet. Check it again in a few minutes, or watch its logs: npx wrangler tail ${name}-api`);
}

function wrangler(wranglerArgs, opts) {
  return run("npx", ["wrangler", ...wranglerArgs], opts);
}

function run(cmd, cmdArgs, { cwd = ROOT, env = {}, input, capture = false } = {}) {
  const res = spawnSync(cmd, cmdArgs, {
    cwd,
    env: { ...process.env, ...env },
    input,
    encoding: "utf8",
    stdio: [input === undefined ? "inherit" : "pipe", capture ? "pipe" : "inherit", "inherit"],
    shell: process.platform === "win32",
  });
  // Never echo the connection string (it holds the database password).
  if (res.status !== 0) fail(`\`${cmd} ${cmdArgs.filter((a) => !a.startsWith("--connection-string")).join(" ")}\` failed`);
  return res.stdout ?? "";
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function step(message) {
  console.log(`\n▸ ${message}`);
}

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

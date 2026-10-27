# bugfree

Self-hosted error tracking for **Next.js** and **Express**, a small Sentry you run yourself. Free and MIT-licensed.

**User guide:** [dwarelab.github.io/bugfree](https://dwarelab.github.io/bugfree/) (source in [`docs/`](docs/index.html)).
Deploy with Docker Compose or to Cloudflare with one command (`npm run deploy:cloudflare`).

- **SDKs:** capture uncaught errors, unhandled rejections, React error-boundary errors, Next.js server errors
  (RSC, route handlers, server actions) and Express route errors. Breadcrumbs (clicks, navigation, fetch/XHR,
  console), request data, user and tags are attached, with per-request isolation on the server.
- **Ingest API:** validates events, un-minifies stack traces with uploaded **source maps** (webpack and
  Turbopack, including sectioned maps), **groups** events into issues by exception type and top in-app frames,
  tracks users affected, tag distributions and hourly counts, and detects **regressions**.
- **Dashboard:** issue list with search, filters, sparklines and bulk actions; issue page with an event chart,
  stack trace with source context, breadcrumbs, request, tags and contexts, and event navigation. Also releases,
  project setup with copy-paste snippets, team members and alerts.
- **Alerts:** a Slack/Discord/generic webhook and email for new issues and regressions, at most once per issue
  every 30 minutes.
- **Bug reports:** a public page per project where your users sign in with GitHub and report bugs, and a Kanban
  board where your team triages them and replies. Reporters only ever see their own reports.
- **Container logs:** a Docker agent ships every container's stdout/stderr, so logs outlive restarts and
  re-creates. Search them by text, level, container or JSON field, tail them live, and jump from an issue to what
  the containers logged around it.

```
your apps ──POST /api/ingest/:project?key=…──▶ API (Express) ──▶ Postgres
  @dwarelab/bugfree-nextjs, -express        symbolicate → group → store → alert
                                                    ▲
CI ── bugfree sourcemaps upload ────────────────────┘          Dashboard (Next.js) ──▶ API
```

## Repository layout

| Path | What |
|---|---|
| `packages/core` | Platform-agnostic SDK core: event model, stack parsing, scope, client, transport |
| `packages/browser` | Browser SDK: global handlers, breadcrumbs, UA contexts |
| `packages/node` | Node SDK: process handlers, per-request scope (AsyncLocalStorage), source context |
| `packages/express` | `requestHandler()` + `errorHandler()` / `setupExpressErrorHandler(app)` |
| `packages/nextjs` | `@dwarelab/bugfree-nextjs` (`captureRequestError`, `withBugfree`), `/client`, `/server` |
| `packages/cli` | `bugfree sourcemaps upload`, `bugfree releases new` |
| `packages/docker-agent` | Ships Docker container logs to bugfree (image `ghcr.io/dwarelab/bugfree-docker-agent`) |
| `apps/api` | Ingest and dashboard API (Express 5 + Postgres) |
| `apps/web` | Dashboard (Next.js 16) |
| `examples/` | `express-demo` and `next-demo`, apps that throw every kind of error |

## Run it locally

Requires Node 20+ and Docker. Bugfree uses ports **3100** (dashboard), **4100** (API) and **5442** (Postgres).

```bash
npm install
npm run build:sdk          # build the SDK packages used by the examples
npm run db:up              # Postgres in Docker
npm run dev:api            # API on :4100 (runs migrations on start)
npm run dev:web            # dashboard on :3100
npm run dev:seed           # dev account + demo projects; writes the examples' env files
```

Open http://localhost:3100. The dev account's credentials are in `scripts/dev-seed.mjs`. Without the seed
script, the first visit asks you to create an admin account.

Try the demos:

```bash
npm run demo:express       # http://localhost:5050: click the links to throw errors
npm run demo:next          # production build + source map upload, then http://localhost:3200
```

Tests: `npm test` (stack parsing, grouping, source-map symbolication).

## Add it to your app

Create a project in the dashboard. Its **Settings & setup** page shows these snippets with your DSN filled in.

### Install

The SDKs are on npm under `@dwarelab`:

| Package | For |
|---|---|
| `@dwarelab/bugfree-nextjs` | Next.js: browser, Node.js server and edge runtime |
| `@dwarelab/bugfree-express` | Express 4 and 5 (includes the Node SDK) |
| `@dwarelab/bugfree-node` | Plain Node.js services, workers and scripts |
| `@dwarelab/bugfree-cli` | `bugfree sourcemaps upload` in CI |

### Next.js (App Router, 15+)

```ts
// instrumentation-client.ts
import { init } from "@dwarelab/bugfree-nextjs/client";
init(); // reads NEXT_PUBLIC_BUGFREE_DSN / NEXT_PUBLIC_BUGFREE_RELEASE
```

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { init } = await import("@dwarelab/bugfree-nextjs/server");
    init();
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    const { initEdge } = await import("@dwarelab/bugfree-nextjs");
    initEdge();
  }
}
export { captureRequestError as onRequestError } from "@dwarelab/bugfree-nextjs";
```

```tsx
// app/error.tsx and app/global-error.tsx
"use client";
import { useReportError } from "@dwarelab/bugfree-nextjs/client";
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useReportError(error);
  return <button onClick={reset}>Try again</button>;
}
```

```ts
// next.config.ts: enables production browser + server source maps and bakes in the release
import { withBugfree } from "@dwarelab/bugfree-nextjs/config";
export default withBugfree({ /* your config */ });
```

```bash
# after `next build` (BUGFREE_URL, BUGFREE_AUTH_TOKEN = project secret key)
bugfree sourcemaps upload --nextjs --delete-after
```

**Releases are detected automatically:** `BUGFREE_RELEASE` if set, otherwise the commit SHA from your CI or
host (Vercel, GitHub Actions, GitLab, Render, Railway, Heroku, Netlify, Cloudflare Pages), otherwise
`git rev-parse HEAD`. The SDK, `withBugfree` and the CLI all use the same order, so events and source maps match.

Server render errors are tagged with the `digest` that `error.tsx` shows your users, so a user's
"Reference: 2128315299" can be found with the search `digest:2128315299`. Hydration mismatches are tagged
`react.hydration:yes`. On Vercel and other serverless hosts, events are handed to the request's
`waitUntil`, so they're delivered even when the function freezes right after the response.

`--delete-after` removes the browser maps from `.next/static` so they aren't served publicly. Server maps stay.

### Express

```js
import * as Bugfree from "@dwarelab/bugfree-express";
Bugfree.init({ dsn: process.env.BUGFREE_DSN, release: process.env.BUGFREE_RELEASE });

import express from "express";
const app = express();
app.use(Bugfree.requestHandler());   // per-request scope: breadcrumbs, user, request data
// … routes …
Bugfree.setupExpressErrorHandler(app); // reports errors without a status or with status >= 500
app.use((err, req, res, next) => res.status(500).json({ eventId: res.locals.bugfreeEventId }));
```

On **Express 4**, which ignores promises returned by handlers, the SDK forwards rejected async handlers to
`next(err)`. Those errors reach your error handler with the request attached, instead of hanging the request.
Disable it with `requestHandler({ patchAsyncHandlers: false })`.

Outgoing requests made with `fetch` and with the `http`/`https` modules (axios, got, node-fetch) are recorded
as breadcrumbs. On SIGTERM/SIGINT the SDK delivers queued events before the process exits, so errors from a
rolling deploy aren't lost. If your app has its own signal handler, that handler still decides when to exit.

Anywhere in your code: `captureException(err)`, `captureMessage(msg, "warning")`, `setUser({ id })`,
`setTag(k, v)`, `addBreadcrumb({ category, message })`, `withScope(scope => …)`, `flush()`.

SDK options (all platforms): `dsn`, `release`, `environment`, `sampleRate`, `ignoreErrors`, `beforeSend`,
`beforeBreadcrumb`, `maxBreadcrumbs`, `initialTags`, `dedupe`, `debug`. Node adds `unhandledRejections`
(`"warn"` | `"strict"` | `"none"`), `consoleBreadcrumbs`, `fetchBreadcrumbs`, `httpBreadcrumbs`,
`flushOnShutdown` and `includeSourceContext`.

## Connect an AI agent (MCP)

The API serves an MCP endpoint at `<API_URL>/mcp` (Streamable HTTP). Create a token under **Team & account → API tokens**, then:

```bash
claude mcp add --transport http bugfree https://api.example.com/mcp --header "Authorization: Bearer bfu_…"
```

Tools: `list_projects`, `list_issues` (same search syntax as the dashboard), `get_issue` (details plus the latest event's symbolicated stack trace, breadcrumbs and request), `list_issue_events`, `get_event`, `find_event` (by SDK event id), `search_logs` (container logs, see below) and `update_issue_status`. Tokens act as the user who created them and see every project, like the dashboard. A **read-only** token gets every tool except `update_issue_status`.

## Container logs

`docker logs` only lasts as long as the container: `docker compose up` re-creates it and the history is gone. Run
the agent once per Docker host and every container's stdout/stderr is kept in bugfree instead (**Logs** in the
project sidebar). The project's **Settings & setup** page has this snippet with your DSN filled in:

```yaml
services:
  bugfree-agent:
    image: ghcr.io/dwarelab/bugfree-docker-agent:latest   # or build: docker build -f packages/docker-agent/Dockerfile .
    restart: unless-stopped
    environment:
      BUGFREE_DSN: "https://<public key>@api.example.com/<project id>"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - bugfree-agent:/data
volumes:
  bugfree-agent:
```

- It follows running containers and every container started later, reading through the Docker Engine API (the
  `json-file`, `local` and `journald` log drivers, Docker's default is `json-file`).
- Read positions are saved in `/data` once the API has stored the lines. Restarting the agent, a container or the
  Docker daemon neither loses nor duplicates lines, and stopped containers are caught up on. When the API is
  unreachable, the agent retries and pauses reading. Docker keeps the lines until it catches up.
- Indented continuation lines (stack frames, `Caused by:`) are folded into the line before them, so an error
  and its stack trace are one entry.
- `BUGFREE_INCLUDE` / `BUGFREE_EXCLUDE` take comma-separated globs on the container or compose service name; the
  label `bugfree.logs=false` also skips a container. `BUGFREE_INITIAL_TAIL` (default 200) is how much history
  already-running containers contribute on first start. `node packages/docker-agent/dist/index.js --help` lists
  everything.
- The Docker socket is root-equivalent. To narrow it, run a socket proxy that allows only `CONTAINERS` and
  `EVENTS` and set `DOCKER_HOST=tcp://socket-proxy:2375`.
- On the issue page, **Logs around this event** opens the logs from 5 minutes before the event to 1 minute after,
  narrowed to the event's container when the SDK's `server_name` is a container id (Node's default hostname in
  Docker). For that, ship logs with the same project's DSN.

Anything else can send logs too: `POST /api/logs/:projectId?key=<public key>` (or the `x-bugfree-key` header) stores up to 5000 log lines per
request, gzip allowed:

```json
{ "host": "web-1", "logs": [{ "timestamp": "2026-10-25T10:00:00Z", "message": "GET /cart 500", "stream": "stderr",
  "container": "shop-api-1", "service": "api", "image": "shop/api:1.4" }] }
```

`level` is optional: it's read from JSON log lines (pino, bunyan, winston …), logfmt `level=` or the text
(`ERROR`, `[warn]`, `TypeError: …`). Other fields of JSON lines are kept as attributes and are searchable as
`field:value`. Lines are rate-limited per project (`LOG_RATE_LIMIT`, default 2000/s) and kept for
`LOG_RETENTION_DAYS` (default 14).

## Bug reports from your users

Turn on **Settings & setup → Bug report page** and share its link (`<APP_URL>/report/<slug>`), or link to it from
your app's help menu with `?url=<current page>` so the form fills in where it happened. People sign in with GitHub,
describe the bug and pick how bad it is. They see only the reports they filed, the status (Received, Planned,
Being worked on, Fixed) and your replies, never your issues, logs or team.

New reports land in the **New** column of the project's **Bug reports** board, and go to the project's alert webhook
and emails. Drag cards between New, To do, In progress, Done and Won't fix, or open one to set its status, severity
and assignee and to reply. Replies are shown to the reporter; **internal notes** are not. Team members appear to
reporters as "<project> team", without their email.

Sign-in needs a GitHub OAuth app (github.com/settings/developers) with the authorization callback URL
`<API_URL>/api/portal/auth/github/callback`; set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` on the API. Outside
production the page also offers a test sign-in without GitHub (`PORTAL_DEV_LOGIN=false` hides it). Reporters have
their own accounts and session cookie, separate from the team's, and can file 10 reports and 60 replies an hour.

## How it works

- **Events** are JSON (`packages/core/src/types.ts`) posted to `POST /api/ingest/:projectId?key=<public key>`.
  Browsers send `text/plain` to avoid a CORS preflight, and the ingest endpoint allows any origin without
  credentials. The public key can only submit events. The API rate-limits per project (token bucket, `429` +
  `Retry-After`, which the SDKs respect).
- **Source maps:** the CLI pairs each JS file with its map through the `sourceMappingURL` comment and stores
  the map under the JS file's name (`~/_next/static/chunks/x.js.map`, `~/.next/server/chunks/y.js.map`). At ingest,
  a frame's URL or path is matched by suffix. The frame then gets the original file, line, column, source context and
  a function name, recovered from the enclosing declaration in the original source or, failing that, from the map's
  names at the caller's call site.
- **Grouping:** fingerprint = exception type + the top 5 in-app frames (normalized path + function, no line
  numbers, build hashes removed), or the normalized message if there's no stack. Override it with
  `fingerprint: ["…"]` (supports `"{{ default }}"`).
- **Regressions:** a resolved issue reopens (and alerts) when an event arrives from a release that hadn't had the
  issue before it was resolved. Events from releases that already had it, such as browser tabs still running the old
  JavaScript, are counted but leave it resolved. Events without a release always reopen it.
- **Retention:** events older than `RETENTION_DAYS` (default 30) are deleted hourly. Issue counters and hourly
  stats are kept. A release's source maps are deleted once it has had no uploads or events for
  `ARTIFACT_RETENTION_DAYS` (default 90); each project's `ARTIFACT_KEEP_RELEASES` (default 5) newest releases
  always keep theirs.
- **Capacity:** events are processed inside the ingest request, in one Postgres transaction that updates the
  issue's row, and the rate limiters are in memory. That suits one API instance taking tens of events per second
  in total; a single very noisy issue is serialized on its row. Use the SDKs' `sampleRate` or `INGEST_RATE_LIMIT`
  for bursty apps.

## Deploying

The dashboard and API run on separate subdomains of one registrable domain, e.g. `app.example.com` and
`api.example.com`. The browser calls the API directly with credentialed CORS. The session cookie is
`HttpOnly`, `SameSite=Lax`, `Secure` in production, and scoped to `COOKIE_DOMAIN=.example.com`. Writes are
CSRF-checked against the `Origin` header.

```bash
cp .env.example .env       # set API_URL, APP_URL, COOKIE_DOMAIN, SMTP…
docker compose up -d --build
```

`NEXT_PUBLIC_API_URL` is baked into the dashboard image at build time from `API_URL`. Put TLS in front of both
services (any reverse proxy) and set `TRUST_PROXY` if it isn't one hop.

API environment variables are documented in `apps/api/.env.example`.

### Cloudflare

The API runs as a Worker (`apps/api/src/worker.ts`, the same Express app) that reaches your Postgres through
Hyperdrive, and the dashboard as a Worker built with OpenNext. Bring a Postgres reachable from the internet (Neon,
Supabase, RDS …) and a Workers Paid plan, then:

```bash
DATABASE_URL='postgres://…?sslmode=require' npm run deploy:cloudflare -- --domain example.com   # or no flag for workers.dev
```

The script logs in with Wrangler, creates the Hyperdrive config (query caching off), deploys both Workers on
`api.` and `app.` custom domains, and applies migrations. It saves its settings in `.cloudflare.json`; re-run
`npm run deploy:cloudflare` to upgrade. `--help` lists the options, including CI use. Locally, `npm run dev:worker -w
@bugfree/api` runs the API in workerd against the Docker Postgres. Add new migrations to
`apps/api/src/worker-migrations.ts` as well (a test checks it).

### Docs site

`docs/index.html` is the public user guide, a single static page. `.github/workflows/docs.yml` publishes it to
GitHub Pages (enable it once under Settings → Pages → Source: GitHub Actions), or `npm run deploy:docs` puts it on
Cloudflare.

## Releasing

```bash
node scripts/set-version.mjs 0.2.0   # bumps every package and their internal references
npm install                          # refresh the lockfile
git commit -am "Release 0.2.0" && git tag v0.2.0 && git push --follow-tags
```

The tag triggers `.github/workflows/release.yml`, which publishes the SDKs to npm (with provenance) and
pushes the `ghcr.io/dwarelab/bugfree-api` image. It needs an `NPM_TOKEN` repository secret: an npm
granular access token with read and write access to the `@dwarelab` packages.

## Not built yet

Performance tracing, session replay, an AI root-cause summary and per-project permissions.

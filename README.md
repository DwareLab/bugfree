# bugfree

Self-hosted error tracking for **Next.js** and **Express**, a small Sentry you run yourself.

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

### Install from GitHub Packages

The SDKs are published to GitHub Packages under `@dwarelab`. GitHub requires a token to install from its
npm registry, even for public packages: create a classic personal access token with the `read:packages`
scope, then add this `.npmrc` to your app (and set `GITHUB_TOKEN` locally and in CI):

```
@dwarelab:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

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

Tools: `list_projects`, `list_issues` (same search syntax as the dashboard), `get_issue` (details plus the latest event's symbolicated stack trace, breadcrumbs and request), `list_issue_events`, `get_event`, `find_event` (by SDK event id) and `update_issue_status`. Tokens act as the user who created them and see every project, like the dashboard.

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
- **Retention:** events older than `RETENTION_DAYS` (default 30) are deleted hourly. Issue counters and hourly
  stats are kept.

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

## Releasing

```bash
node scripts/set-version.mjs 0.2.0   # bumps every package and their internal references
npm install                          # refresh the lockfile
git commit -am "Release 0.2.0" && git tag v0.2.0 && git push --follow-tags
```

The tag triggers `.github/workflows/release.yml`, which publishes the SDKs to GitHub Packages and pushes
`ghcr.io/dwarelab/bugfree-api` and `ghcr.io/dwarelab/bugfree-web` images.

## Not built yet

Performance tracing, session replay, an AI root-cause summary and per-project permissions.

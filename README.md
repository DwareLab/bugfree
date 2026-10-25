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
  @bugfree/nextjs, @bugfree/express             symbolicate → group → store → alert
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
| `packages/nextjs` | `@bugfree/nextjs` (`captureRequestError`, `withBugfree`), `/client`, `/server` |
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

### Next.js (App Router, 15+)

```ts
// instrumentation-client.ts
import { init } from "@bugfree/nextjs/client";
init(); // reads NEXT_PUBLIC_BUGFREE_DSN / NEXT_PUBLIC_BUGFREE_RELEASE
```

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { init } = await import("@bugfree/nextjs/server");
    init();
  }
}
export { captureRequestError as onRequestError } from "@bugfree/nextjs";
```

```tsx
// app/error.tsx and app/global-error.tsx
"use client";
import { useReportError } from "@bugfree/nextjs/client";
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useReportError(error);
  return <button onClick={reset}>Try again</button>;
}
```

```ts
// next.config.ts: enables production browser + server source maps, passes BUGFREE_RELEASE to the client
import { withBugfree } from "@bugfree/nextjs";
export default withBugfree({ /* your config */ });
```

```bash
# after `next build` (BUGFREE_URL, BUGFREE_AUTH_TOKEN = project secret key)
bugfree sourcemaps upload --nextjs --release "$BUGFREE_RELEASE" --delete-after
```

`--delete-after` removes the browser maps from `.next/static` so they aren't served publicly. Server maps stay.

### Express

```js
import * as Bugfree from "@bugfree/express";
Bugfree.init({ dsn: process.env.BUGFREE_DSN, release: process.env.BUGFREE_RELEASE });

import express from "express";
const app = express();
app.use(Bugfree.requestHandler());   // per-request scope: breadcrumbs, user, request data
// … routes …
Bugfree.setupExpressErrorHandler(app); // reports errors without a status or with status >= 500
app.use((err, req, res, next) => res.status(500).json({ eventId: res.locals.bugfreeEventId }));
```

Anywhere in your code: `captureException(err)`, `captureMessage(msg, "warning")`, `setUser({ id })`,
`setTag(k, v)`, `addBreadcrumb({ category, message })`, `withScope(scope => …)`, `flush()`.

SDK options (all platforms): `dsn`, `release`, `environment`, `sampleRate`, `ignoreErrors`, `beforeSend`,
`beforeBreadcrumb`, `maxBreadcrumbs`, `initialTags`, `debug`. Node adds `unhandledRejections`
(`"warn"` | `"strict"` | `"none"`), `consoleBreadcrumbs`, `fetchBreadcrumbs` and `includeSourceContext`.

### Using the SDKs before they're on npm

The packages aren't published. From your app, either point at this repo
(`"@bugfree/nextjs": "file:../bugfree/packages/nextjs"`, plus `core`, `browser` and `node`), or build tarballs with
`npm pack -w @bugfree/core -w @bugfree/browser -w @bugfree/node -w @bugfree/nextjs -w @bugfree/express -w @bugfree/cli`
and install those.

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

## Not built yet

Performance tracing, session replay, an AI root-cause summary, per-project permissions, issue
merging/assignment, and the edge runtime for Next.js server code (the Node.js runtime is supported).

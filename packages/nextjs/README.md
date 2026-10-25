# @dwarelab/bugfree-nextjs

Error tracking for Next.js (App Router, 15+) with [bugfree](https://github.com/DwareLab/bugfree), the self-hosted Sentry alternative.

```bash
npm install @dwarelab/bugfree-nextjs
npm install -D @dwarelab/bugfree-cli
```

| Import | Use it in |
|---|---|
| `@dwarelab/bugfree-nextjs/client` | `instrumentation-client.ts`, `error.tsx` (`init`, `useReportError`, `ErrorBoundary`) |
| `@dwarelab/bugfree-nextjs/server` | `instrumentation.ts` for the Node.js runtime (`init`) |
| `@dwarelab/bugfree-nextjs` | `instrumentation.ts` (`captureRequestError`, `initEdge`); edge-safe |
| `@dwarelab/bugfree-nextjs/config` | `next.config.ts` (`withBugfree`) |

Full docs and the self-hosted server: https://github.com/DwareLab/bugfree

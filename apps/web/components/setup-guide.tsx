"use client";

import { useState } from "react";
import type { Project } from "@/lib/api";
import { CodeBlock, Segmented } from "./ui";

type Platform = "nextjs" | "express";

export function SetupGuide({ project }: { project: Project }) {
  const [platform, setPlatform] = useState<Platform>(project.platform === "express" || project.platform === "node" ? "express" : "nextjs");
  return (
    <div className="space-y-4">
      <Segmented<Platform>
        value={platform}
        onChange={setPlatform}
        options={[
          { value: "nextjs", label: "Next.js" },
          { value: "express", label: "Express / Node" },
        ]}
      />
      {platform === "nextjs" ? <NextSteps project={project} /> : <ExpressSteps project={project} />}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="tabular mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-ink-2">{n}</span>
      <div className="min-w-0 flex-1 space-y-2">
        <h3 className="text-sm font-medium text-ink">{title}</h3>
        {children}
      </div>
    </div>
  );
}

const P = ({ children }: { children: React.ReactNode }) => <p className="text-sm text-ink-2">{children}</p>;
const C = ({ children }: { children: React.ReactNode }) => <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[12px] text-ink">{children}</code>;

function NextSteps({ project }: { project: Project }) {
  return (
    <div className="space-y-5">
      <Step n={1} title="Install the SDK and CLI">
        <CodeBlock code={`npm install @dwarelab/bugfree-nextjs\nnpm install -D @dwarelab/bugfree-cli`} title="terminal" />
      </Step>
      <Step n={2} title="Add environment variables">
        <CodeBlock
          title=".env.local"
          code={`NEXT_PUBLIC_BUGFREE_DSN=${project.dsn}\n# Set per deploy (git sha, version …); must match the source map upload\nBUGFREE_RELEASE=my-app@1.0.0`}
        />
      </Step>
      <Step n={3} title="Report browser errors">
        <CodeBlock
          title="instrumentation-client.ts"
          code={`import { init } from "@dwarelab/bugfree-nextjs/client";

init({
  // dsn, release and environment default to NEXT_PUBLIC_BUGFREE_* env vars
  sampleRate: 1,
});`}
        />
      </Step>
      <Step n={4} title="Report server errors (RSC, route handlers, server actions)">
        <CodeBlock
          title="instrumentation.ts"
          code={`export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { init } = await import("@dwarelab/bugfree-nextjs/server");
    init();
  }
}

export { captureRequestError as onRequestError } from "@dwarelab/bugfree-nextjs";`}
        />
      </Step>
      <Step n={5} title="Report errors caught by error boundaries">
        <CodeBlock
          title="app/error.tsx (same for app/global-error.tsx)"
          code={`"use client";
import { useReportError } from "@dwarelab/bugfree-nextjs/client";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useReportError(error);
  return (
    <div>
      <h2>Something went wrong</h2>
      <button onClick={reset}>Try again</button>
    </div>
  );
}`}
        />
      </Step>
      <Step n={6} title="Enable source maps and upload them after each build">
        <CodeBlock
          title="next.config.ts"
          code={`import { withBugfree } from "@dwarelab/bugfree-nextjs";

export default withBugfree({
  // your config
});`}
        />
        <CodeBlock
          title="package.json"
          code={`"scripts": {
  "build": "next build && bugfree sourcemaps upload --nextjs --release $BUGFREE_RELEASE --delete-after"
}`}
        />
        <P>
          The CLI reads <C>BUGFREE_URL={project.api_url}</C> and <C>BUGFREE_AUTH_TOKEN</C> (the project&apos;s secret key below) from the environment.{" "}
          <C>--delete-after</C> removes the browser maps so they aren&apos;t served publicly.
        </P>
      </Step>
    </div>
  );
}

function ExpressSteps({ project }: { project: Project }) {
  return (
    <div className="space-y-5">
      <Step n={1} title="Install the SDK">
        <CodeBlock code={`npm install @dwarelab/bugfree-express`} title="terminal" />
      </Step>
      <Step n={2} title="Initialize before anything else, then add the two middlewares">
        <CodeBlock
          title="server.js"
          code={`import * as Bugfree from "@dwarelab/bugfree-express";

Bugfree.init({
  dsn: "${project.dsn}",
  release: process.env.BUGFREE_RELEASE,
  environment: process.env.NODE_ENV,
});

import express from "express";

const app = express();
app.use(Bugfree.requestHandler()); // per-request breadcrumbs, user, request data
app.use(express.json());

// … your routes …

Bugfree.setupExpressErrorHandler(app); // after routes, before your own error handler
app.use((err, req, res, next) => {
  res.status(500).json({ error: "Internal error", eventId: res.locals.bugfreeEventId });
});`}
        />
        <P>
          Uncaught exceptions and unhandled rejections are reported automatically. Use <C>Bugfree.setUser()</C>, <C>setTag()</C>,{" "}
          <C>addBreadcrumb()</C> and <C>captureException()</C> anywhere in a request.
        </P>
      </Step>
      <Step n={3} title="TypeScript / bundled builds: upload source maps">
        <CodeBlock
          title="terminal"
          code={`# compile with "sourceMap": true, then:
BUGFREE_URL=${project.api_url} BUGFREE_AUTH_TOKEN=<secret key> \\
  npx @dwarelab/bugfree-cli sourcemaps upload dist --url-prefix ~/dist --release $BUGFREE_RELEASE`}
        />
      </Step>
    </div>
  );
}

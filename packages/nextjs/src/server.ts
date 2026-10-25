import { type NodeClient, type NodeOptions, init as nodeInit } from "@dwarelab/bugfree-node";

export * from "@dwarelab/bugfree-node";
export { captureRequestError } from "./index";

/**
 * Server-side init for the Node.js runtime. Call it from `register()` in `instrumentation.ts`:
 *
 *   if (process.env.NEXT_RUNTIME === "nodejs") (await import("@dwarelab/bugfree-nextjs/server")).init({ dsn: ... });
 */
export function init(options: NodeOptions = {}): NodeClient {
  return nodeInit({
    dsn: process.env.BUGFREE_DSN ?? process.env.NEXT_PUBLIC_BUGFREE_DSN,
    release: process.env.BUGFREE_RELEASE ?? process.env.NEXT_PUBLIC_BUGFREE_RELEASE,
    environment: process.env.BUGFREE_ENVIRONMENT ?? process.env.NODE_ENV,
    ...options,
    initialTags: { runtime: "nextjs-server", ...options.initialTags },
  });
}

import { getClient, scrubHeaders, scrubUrl } from "@bugfree/core";

export interface RequestErrorContext {
  routerKind: "Pages Router" | "App Router";
  routePath: string;
  routeType: "render" | "route" | "action" | "proxy" | "middleware";
  renderSource?: string;
  revalidateReason?: "on-demand" | "stale" | undefined;
}

export interface ErrorRequest {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Next.js `onRequestError` hook. In `instrumentation.ts`:
 *
 *   export { captureRequestError as onRequestError } from "@bugfree/nextjs";
 */
export async function captureRequestError(error: unknown, request: Readonly<ErrorRequest>, context: Readonly<RequestErrorContext>): Promise<void> {
  const client = getClient();
  if (!client) return;
  const headers = scrubHeaders(request.headers);
  const host = headers["x-forwarded-host"] ?? headers.host;
  const proto = headers["x-forwarded-proto"]?.split(",")[0] ?? "http";
  const [pathname, query] = request.path.split("?");
  client.captureException(error, {
    level: "error",
    mechanism: { type: "nextjs.onRequestError", handled: false },
    transaction: `${request.method} ${context.routePath}`,
    request: {
      method: request.method,
      url: host ? `${proto}://${host}${pathname}` : pathname,
      query_string: query ? scrubUrl(`?${query}`).slice(1) : undefined,
      headers,
    },
    tags: {
      "nextjs.router": context.routerKind,
      "nextjs.route_type": context.routeType,
      ...(context.renderSource ? { "nextjs.render_source": context.renderSource } : {}),
    },
    contexts: { nextjs: { ...context } },
  });
  // Serverless functions may freeze right after the response; deliver before returning.
  await client.flush(2000);
}

export interface WithBugfreeOptions {
  /** Release name baked into the build (exposed as NEXT_PUBLIC_BUGFREE_RELEASE). */
  release?: string;
  /** Generate browser and server source maps so stack traces can be un-minified. Default true. */
  sourceMaps?: boolean;
}

type NextConfigObject = Record<string, any>;
type NextConfigInput = NextConfigObject | ((...args: any[]) => NextConfigObject | Promise<NextConfigObject>);

/** Wraps next.config to enable production source maps and pass the release to client and server code. */
export function withBugfree<T extends NextConfigInput>(nextConfig: T, options: WithBugfreeOptions = {}): T {
  const apply = (config: NextConfigObject): NextConfigObject => {
    const release = options.release ?? process.env.BUGFREE_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA;
    const sourceMaps = options.sourceMaps !== false;
    return {
      ...config,
      ...(sourceMaps ? { productionBrowserSourceMaps: true } : {}),
      experimental: { ...config.experimental, ...(sourceMaps ? { serverSourceMaps: true } : {}) },
      env: { ...config.env, ...(release ? { NEXT_PUBLIC_BUGFREE_RELEASE: release } : {}) },
    };
  };
  if (typeof nextConfig === "function") {
    return (async (...args: unknown[]) => apply(await nextConfig(...args))) as T;
  }
  return apply(nextConfig) as T;
}

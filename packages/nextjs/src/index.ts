import {
  BaseClient,
  type BaseTransport,
  type BugfreeEvent,
  type ClientOptions,
  type TransportResult,
  getClient,
  scrubHeaders,
  scrubUrl,
  setCurrentClient,
} from "@dwarelab/bugfree-core";

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
 *   export { captureRequestError as onRequestError } from "@dwarelab/bugfree-nextjs";
 */
export async function captureRequestError(error: unknown, request: Readonly<ErrorRequest>, context: Readonly<RequestErrorContext>): Promise<void> {
  const client = getClient();
  if (!client) return;
  const headers = scrubHeaders(request.headers);
  const host = headers["x-forwarded-host"] ?? headers.host;
  const proto = headers["x-forwarded-proto"]?.split(",")[0] ?? "http";
  const [pathname, query] = request.path.split("?");
  // Server render errors carry the digest that error.tsx shows users, so reports can be looked up by it.
  const digest = typeof (error as { digest?: unknown })?.digest === "string" ? (error as { digest: string }).digest : undefined;
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
      ...(digest ? { digest } : {}),
    },
    contexts: { nextjs: { ...context } },
  });
  // Serverless functions may freeze right after the response; deliver before returning.
  await client.flush(2000);
}

class EdgeTransport implements BaseTransport {
  constructor(readonly url: string) {}

  async send(event: BugfreeEvent): Promise<TransportResult> {
    const res = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event) });
    return { status: res.status, retryAfter: Number(res.headers.get("retry-after")) || undefined };
  }
}

/** Minimal client for the edge runtime (no Node APIs): edge route handlers and middleware/proxy. */
export class EdgeClient extends BaseClient {
  protected readonly sdkName = "bugfree.nextjs.edge";
  protected readonly platform = "javascript" as const;

  protected createTransport(url: string): BaseTransport {
    return new EdgeTransport(url);
  }
}

/**
 * Edge-runtime init. In `instrumentation.ts`:
 *
 *   if (process.env.NEXT_RUNTIME === "edge") (await import("@dwarelab/bugfree-nextjs")).initEdge();
 */
export function initEdge(options: ClientOptions = {}): EdgeClient {
  const client = new EdgeClient({
    dsn: process.env.BUGFREE_DSN ?? process.env.NEXT_PUBLIC_BUGFREE_DSN,
    release: process.env.BUGFREE_RELEASE ?? process.env.NEXT_PUBLIC_BUGFREE_RELEASE,
    environment: process.env.BUGFREE_ENVIRONMENT ?? process.env.NODE_ENV,
    ...options,
    initialTags: { runtime: "nextjs-edge", ...options.initialTags },
  });
  setCurrentClient(client);
  return client;
}

import { type RequestInfo, getClient, normalize, scrubHeaders, scrubUrl } from "@dwarelab/bugfree-core";
import { type NodeClient, runWithRequestScope } from "@dwarelab/bugfree-node";
import type { ErrorRequestHandler, Request, RequestHandler } from "express";

export * from "@dwarelab/bugfree-node";

export interface ExpressHandlerOptions {
  /**
   * Express 4 only: forward promises rejected by async handlers to `next(err)` so they reach the
   * error handler (Express 5 does this natively). Default true.
   */
  patchAsyncHandlers?: boolean;
  /** Decide which errors are reported. Default: errors without a status, or with status >= 500. */
  shouldHandleError?: (error: unknown) => boolean;
  /** Attach the client IP address as the event user. Default false. */
  includeIp?: boolean;
}

/**
 * Isolates breadcrumbs, user and tags per request and attaches request data to events.
 * Register it before your routes: `app.use(requestHandler())`.
 */
export function requestHandler(options: ExpressHandlerOptions = {}): RequestHandler {
  return (req, _res, next) => {
    if (options.patchAsyncHandlers !== false) patchExpress4(req.app);
    runWithRequestScope(getClient<NodeClient>(), (scope) => {
      if (scope) {
        // Resolved lazily: the matched route and parsed body only exist once routing has run.
        lazyField(scope, "transaction", () => transactionName(req));
        lazyField(scope, "request", () => extractRequest(req));
        if (options.includeIp && req.ip) scope.setUser({ ...scope.user, ip_address: req.ip });
      }
      next();
    });
  };
}

/**
 * Reports errors passed to `next(err)` or thrown from async handlers (Express 5).
 * Register it after your routes and before your own error handlers.
 */
export function errorHandler(options: ExpressHandlerOptions = {}): ErrorRequestHandler {
  const shouldHandle = options.shouldHandleError ?? defaultShouldHandleError;
  return (err, req, res, next) => {
    if (shouldHandle(err)) {
      const eventId = getClient()?.captureException(err, {
        mechanism: { type: "express", handled: false },
        level: "error",
        request: extractRequest(req),
        transaction: transactionName(req),
        user: options.includeIp && req.ip ? { ip_address: req.ip } : undefined,
      });
      if (eventId) res.locals.bugfreeEventId = eventId;
    }
    next(err);
  };
}

/** Shorthand for `app.use(errorHandler(options))`. */
export function setupExpressErrorHandler(app: { use: (handler: ErrorRequestHandler) => unknown }, options?: ExpressHandlerOptions): void {
  if (options?.patchAsyncHandlers !== false) patchExpress4(app);
  app.use(errorHandler(options));
}

const PATCHED = Symbol.for("bugfree.express4.patched");

interface Express4Layer {
  handle: (...args: unknown[]) => unknown;
  handle_request: (req: unknown, res: unknown, next: (err?: unknown) => void) => void;
  [PATCHED]?: boolean;
}

/**
 * Express 4 calls handlers without looking at their return value, so a rejected async handler
 * never reaches the error middleware and the request hangs. Wrap Layer#handle_request (shared by
 * app, router and route layers) to forward rejections to next(err).
 */
export function patchExpress4(app: unknown): void {
  const router = (app as { _router?: { stack?: Array<{ constructor: { prototype: Express4Layer } }> } } | undefined)?._router;
  const proto = router?.stack?.[0]?.constructor?.prototype;
  if (!proto || typeof proto.handle_request !== "function" || proto[PATCHED]) return;
  Object.defineProperty(proto, PATCHED, { value: true });
  proto.handle_request = function (this: Express4Layer, req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next();
    try {
      const result = fn(req, res, next) as { then?: unknown } | undefined;
      if (result && typeof result.then === "function") {
        (result as Promise<unknown>).then(undefined, (err: unknown) => next(err ?? new Error("Async handler rejected without a reason")));
      }
    } catch (err) {
      next(err);
    }
  };
}

/** Computes `scope[key]` on read unless something explicitly sets it. */
function lazyField<T extends object>(target: T, key: keyof T & string, compute: () => unknown): void {
  let override: unknown;
  Object.defineProperty(target, key, {
    get: () => override ?? compute(),
    set: (value: unknown) => {
      override = value;
    },
    enumerable: true,
    configurable: true,
  });
}

function defaultShouldHandleError(error: unknown): boolean {
  const e = error as { status?: unknown; statusCode?: unknown } | null;
  const status = Number(e?.status ?? e?.statusCode);
  return !Number.isFinite(status) || status >= 500;
}

function transactionName(req: Request): string {
  const routePath = req.route?.path;
  const path = typeof routePath === "string" ? `${req.baseUrl}${routePath}` : req.baseUrl + req.path;
  return `${req.method} ${path || "/"}`;
}

function extractRequest(req: Request): RequestInfo {
  const host = req.get("host") ?? "localhost";
  const queryIndex = req.originalUrl.indexOf("?");
  const info: RequestInfo = {
    method: req.method,
    url: scrubUrl(`${req.protocol}://${host}${req.originalUrl}`).split("?")[0],
    query_string: queryIndex >= 0 ? scrubUrl(req.originalUrl.slice(queryIndex)).slice(1) : undefined,
    headers: scrubHeaders(req.headers as Record<string, unknown>),
  };
  const body: unknown = req.body;
  if (body !== undefined && body !== null && !(typeof body === "object" && Object.keys(body).length === 0)) {
    info.data = typeof body === "string" ? body.slice(0, 10_000) : normalize(body, 4, 50);
  }
  return info;
}

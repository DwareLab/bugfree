import { type RequestInfo, getClient, normalize, scrubHeaders, scrubUrl } from "@bugfree/core";
import { type NodeClient, runWithRequestScope } from "@bugfree/node";
import type { ErrorRequestHandler, Request, RequestHandler } from "express";

export * from "@bugfree/node";

export interface ExpressHandlerOptions {
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
  app.use(errorHandler(options));
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

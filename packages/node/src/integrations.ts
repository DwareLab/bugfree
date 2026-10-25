import diagnostics from "node:diagnostics_channel";
import type { ClientRequest, IncomingMessage } from "node:http";
import { format } from "node:util";
import { type Level, scrubUrl, truncate } from "@dwarelab/bugfree-core";
import type { NodeClient } from "./client";

const PATCHED = Symbol.for("bugfree.patched");

export function installUncaughtExceptionHandler(get: () => NodeClient): void {
  const handler = (error: Error) => {
    get().captureException(error, { level: "fatal", mechanism: { type: "onuncaughtexception", handled: false } });
    const otherHandlers = process.listeners("uncaughtException").filter((l) => l !== handler);
    if (otherHandlers.length === 0) {
      // Keep Node's default behaviour: print and exit, but give the event a moment to be delivered.
      console.error(error);
      get().flush(2000).finally(() => process.exit(1));
    }
  };
  process.on("uncaughtException", handler);
}

export function installUnhandledRejectionHandler(get: () => NodeClient, mode: "warn" | "strict"): void {
  process.on("unhandledRejection", (reason) => {
    get().captureException(reason, { level: "error", mechanism: { type: "onunhandledrejection", handled: false } });
    if (mode === "strict") {
      console.error(reason);
      get().flush(2000).finally(() => process.exit(1));
    } else {
      console.warn("[bugfree] Unhandled promise rejection:", reason);
    }
  });
}

const CONSOLE_LEVELS: Record<string, Level> = { log: "info", info: "info", warn: "warning", error: "error", debug: "debug" };

export function installConsoleBreadcrumbs(get: () => NodeClient): void {
  for (const method of Object.keys(CONSOLE_LEVELS) as Array<keyof Console>) {
    const original = console[method] as ((...args: unknown[]) => void) & { [PATCHED]?: boolean };
    if (typeof original !== "function" || original[PATCHED]) continue;
    const patched = function (this: Console, ...args: unknown[]) {
      try {
        get().addBreadcrumb({
          type: "console",
          category: "console",
          level: CONSOLE_LEVELS[method],
          message: truncate(format(...args), 1000),
        });
      } catch {
        // never break logging
      }
      return original.apply(this, args);
    };
    Object.defineProperty(patched, PATCHED, { value: true });
    (console as unknown as Record<string, unknown>)[method] = patched;
  }
}

export function installFetchBreadcrumbs(get: () => NodeClient): void {
  const original = globalThis.fetch as typeof fetch & { [PATCHED]?: boolean };
  if (typeof original !== "function" || original[PATCHED]) return;
  const patched = async function (input: Parameters<typeof fetch>[0], init?: RequestInit) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const ingest = get().ingestUrl;
    if (ingest && url.startsWith(ingest.split("?")[0])) return original(input, init);
    const started = Date.now();
    try {
      const res = await original(input, init);
      get().addBreadcrumb({
        type: "http",
        category: "fetch",
        level: res.status >= 500 ? "error" : res.status >= 400 ? "warning" : "info",
        data: { method, url: scrubUrl(url), status_code: res.status, duration_ms: Date.now() - started },
      });
      return res;
    } catch (err) {
      get().addBreadcrumb({
        type: "http",
        category: "fetch",
        level: "error",
        data: { method, url: scrubUrl(url), error: String(err), duration_ms: Date.now() - started },
      });
      throw err;
    }
  } as typeof fetch & { [PATCHED]?: boolean };
  Object.defineProperty(patched, PATCHED, { value: true });
  globalThis.fetch = patched;
}

/**
 * Outgoing http/https requests via diagnostics_channel (Node 20+), so axios and other
 * http-module clients show up without monkey-patching.
 */
export function installHttpBreadcrumbs(get: () => NodeClient): void {
  const started = new WeakMap<ClientRequest, number>();
  const urlOf = (req: ClientRequest) => {
    const host = req.getHeader("host") ?? req.host ?? "localhost";
    return scrubUrl(`${req.protocol ?? "http:"}//${host}${req.path}`);
  };
  diagnostics.subscribe("http.client.request.start", (message) => {
    started.set((message as { request: ClientRequest }).request, Date.now());
  });
  diagnostics.subscribe("http.client.response.finish", (message) => {
    const { request, response } = message as { request: ClientRequest; response: IncomingMessage };
    const status = response.statusCode ?? 0;
    get().addBreadcrumb({
      type: "http",
      category: "http",
      level: status >= 500 ? "error" : status >= 400 ? "warning" : "info",
      data: { method: request.method, url: urlOf(request), status_code: status, duration_ms: Date.now() - (started.get(request) ?? Date.now()) },
    });
  });
  diagnostics.subscribe("http.client.request.error", (message) => {
    const { request, error } = message as { request: ClientRequest; error: Error };
    get().addBreadcrumb({
      type: "http",
      category: "http",
      level: "error",
      data: { method: request.method, url: urlOf(request), error: String(error), duration_ms: Date.now() - (started.get(request) ?? Date.now()) },
    });
  });
}

/**
 * Flushes queued events on SIGTERM / SIGINT. If nothing else handles the signal, the process then
 * exits the way Node would have (re-raising the signal); otherwise the app's own handler stays in charge.
 */
export function installShutdownFlush(get: () => NodeClient): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const handler = () => {
      void get()
        .flush(2000)
        .finally(() => {
          const others = process.listeners(signal).filter((l) => l !== handler);
          if (others.length === 0) {
            process.removeListener(signal, handler);
            process.kill(process.pid, signal);
          }
        });
    };
    process.on(signal, handler);
  }
}

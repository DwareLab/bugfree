import { type Level, scrubUrl, truncate } from "@dwarelab/bugfree-core";
import type { BrowserClient } from "./client";

type Get = () => BrowserClient;
const PATCHED = Symbol.for("bugfree.patched");

// React reports hydration mismatches as recoverable errors through window.reportError.
const HYDRATION = /hydrat|did not match|Minified React error #(418|419|421|422|423|425)\b/i;

export function installGlobalHandlers(get: Get): void {
  window.addEventListener("error", (event: ErrorEvent) => {
    const client = get();
    if (event.error) {
      const message = String((event.error as Error)?.message ?? "");
      const hydration = HYDRATION.test(message);
      client.captureException(event.error, {
        level: "error",
        mechanism: { type: hydration ? "react.hydration" : "onerror", handled: false },
        tags: hydration ? { "react.hydration": "yes" } : undefined,
      });
      return;
    }
    // Errors without an Error object, e.g. cross-origin scripts ("Script error.") or resource failures.
    if (!event.message) return;
    client.captureEvent(
      {
        level: "error",
        exception: {
          values: [
            {
              type: "Error",
              value: event.message,
              mechanism: { type: "onerror", handled: false },
              stacktrace: event.filename
                ? { frames: [{ filename: event.filename, abs_path: event.filename, lineno: event.lineno, colno: event.colno, function: "?" }] }
                : undefined,
            },
          ],
        },
      },
      { originalException: event },
    );
  });

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    get().captureException(event.reason ?? "Unhandled promise rejection with no reason", {
      level: "error",
      mechanism: { type: "onunhandledrejection", handled: false },
    });
  });
}

const CONSOLE_LEVELS: Record<string, Level> = { log: "info", info: "info", warn: "warning", error: "error", debug: "debug" };

export function installConsoleBreadcrumbs(get: Get): void {
  for (const method of Object.keys(CONSOLE_LEVELS)) {
    const c = console as unknown as Record<string, ((...args: unknown[]) => void) & { [PATCHED]?: boolean }>;
    const original = c[method];
    if (typeof original !== "function" || original[PATCHED]) continue;
    const patched = function (this: Console, ...args: unknown[]) {
      try {
        get().addBreadcrumb({ type: "console", category: "console", level: CONSOLE_LEVELS[method], message: truncate(args.map(stringify).join(" "), 1000) });
      } catch {
        // never break logging
      }
      return original.apply(this, args);
    };
    Object.defineProperty(patched, PATCHED, { value: true });
    c[method] = patched;
  }
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function installDomBreadcrumbs(get: Get): void {
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target as Element | null;
      if (!target || !(target instanceof Element)) return;
      get().addBreadcrumb({ type: "ui", category: "ui.click", message: describeElement(target) });
    },
    { capture: true, passive: true },
  );
}

/** e.g. `button#save.btn.primary "Save changes"`. Never includes input values. */
function describeElement(el: Element): string {
  const clickable = el.closest("a,button,[role=button],input,select,label,summary") ?? el;
  let out = clickable.tagName.toLowerCase();
  if (clickable.id) out += `#${clickable.id}`;
  const classes = typeof clickable.className === "string" ? clickable.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
  if (classes.length) out += `.${classes.join(".")}`;
  for (const attr of ["name", "type", "aria-label", "data-testid"]) {
    const v = clickable.getAttribute(attr);
    if (v) out += `[${attr}="${truncate(v, 40)}"]`;
  }
  if (!(clickable instanceof HTMLInputElement) && !(clickable instanceof HTMLSelectElement)) {
    const text = (clickable.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text) out += ` "${truncate(text, 40)}"`;
  }
  return out;
}

export function installHistoryBreadcrumbs(get: Get): void {
  let last = location.href;
  const record = (to: string) => {
    const from = last;
    last = to;
    if (from !== to) get().addBreadcrumb({ type: "navigation", category: "navigation", data: { from: scrubUrl(from), to: scrubUrl(to) } });
  };
  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method] as History["pushState"] & { [PATCHED]?: boolean };
    if (original[PATCHED]) continue;
    const patched = function (this: History, ...args: Parameters<History["pushState"]>) {
      const result = original.apply(this, args);
      try {
        record(location.href);
      } catch {
        // ignore
      }
      return result;
    };
    Object.defineProperty(patched, PATCHED, { value: true });
    history[method] = patched;
  }
  window.addEventListener("popstate", () => record(location.href));
}

export function installFetchBreadcrumbs(get: Get): void {
  const original = window.fetch as typeof fetch & { [PATCHED]?: boolean };
  if (typeof original !== "function" || original[PATCHED]) return;
  const patched = async function (this: unknown, input: Parameters<typeof fetch>[0], init?: RequestInit) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const ingest = get().ingestUrl;
    if (ingest && url.startsWith(ingest.split("?")[0])) return original.call(window, input, init);
    const started = Date.now();
    try {
      const res = await original.call(window, input, init);
      get().addBreadcrumb({
        type: "http",
        category: "fetch",
        level: res.status >= 500 ? "error" : res.status >= 400 ? "warning" : "info",
        data: { method, url: scrubUrl(url), status_code: res.status, duration_ms: Date.now() - started },
      });
      return res;
    } catch (err) {
      get().addBreadcrumb({ type: "http", category: "fetch", level: "error", data: { method, url: scrubUrl(url), error: String(err), duration_ms: Date.now() - started } });
      throw err;
    }
  } as typeof fetch & { [PATCHED]?: boolean };
  Object.defineProperty(patched, PATCHED, { value: true });
  window.fetch = patched;
}

export function installXhrBreadcrumbs(get: Get): void {
  const proto = XMLHttpRequest.prototype as XMLHttpRequest & { [PATCHED]?: boolean };
  if (proto[PATCHED]) return;
  Object.defineProperty(proto, PATCHED, { value: true });
  const info = new WeakMap<XMLHttpRequest, { method: string; url: string; started?: number }>();
  const originalOpen = proto.open;
  const originalSend = proto.send;
  proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    info.set(this, { method: method.toUpperCase(), url: String(url) });
    return (originalOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as XMLHttpRequest["open"];
  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = info.get(this);
    if (meta) {
      meta.started = Date.now();
      this.addEventListener("loadend", () => {
        get().addBreadcrumb({
          type: "http",
          category: "xhr",
          level: this.status === 0 || this.status >= 500 ? "error" : this.status >= 400 ? "warning" : "info",
          data: { method: meta.method, url: scrubUrl(meta.url), status_code: this.status, duration_ms: Date.now() - meta.started! },
        });
      });
    }
    return originalSend.call(this, body);
  };
}

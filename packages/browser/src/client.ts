import {
  BaseClient,
  type BaseTransport,
  type BugfreeEvent,
  type ClientOptions,
  type EventHint,
  type StackFrame,
  type TransportResult,
  scrubUrl,
} from "@dwarelab/bugfree-core";

export interface BrowserOptions extends ClientOptions {
  /** Report errors from window "error" and "unhandledrejection" events. Default true. */
  globalHandlers?: boolean;
  /** Breadcrumbs to record automatically. All default to true. */
  breadcrumbs?: { console?: boolean; dom?: boolean; fetch?: boolean; xhr?: boolean; history?: boolean };
  /** Drop events whose throwing frame comes from these URLs (browser extensions by default). */
  denyUrls?: Array<string | RegExp>;
}

const DEFAULT_IGNORE_ERRORS: Array<string | RegExp> = [
  "ResizeObserver loop limit exceeded",
  "ResizeObserver loop completed with undelivered notifications",
  /^Error: Script error\.?$/,
];
const DEFAULT_DENY_URLS: Array<string | RegExp> = [/^(chrome|moz|safari|safari-web)-extension:\/\//];

class BrowserTransport implements BaseTransport {
  constructor(readonly url: string) {}

  async send(event: BugfreeEvent): Promise<TransportResult> {
    const body = JSON.stringify(event);
    const res = await fetch(this.url, {
      method: "POST",
      // text/plain keeps this a "simple" CORS request: no preflight round-trip.
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body,
      // keepalive lets the request finish while the page unloads; it is limited to 64KB.
      keepalive: body.length < 60_000,
      credentials: "omit",
      mode: "cors",
    });
    return { status: res.status, retryAfter: Number(res.headers.get("retry-after")) || undefined };
  }
}

export class BrowserClient extends BaseClient<BrowserOptions> {
  protected readonly sdkName = "bugfree.browser";
  protected readonly platform = "javascript" as const;
  readonly ingestUrl?: string;

  constructor(options: BrowserOptions) {
    super({
      dedupe: true,
      ...options,
      ignoreErrors: [...DEFAULT_IGNORE_ERRORS, ...(options.ignoreErrors ?? [])],
      denyUrls: [...DEFAULT_DENY_URLS, ...(options.denyUrls ?? [])],
    });
    this.ingestUrl = (this.transport as BrowserTransport | undefined)?.url;
  }

  protected createTransport(url: string): BaseTransport {
    return new BrowserTransport(url);
  }

  protected override prepareEvent(event: BugfreeEvent, _hint: EventHint): BugfreeEvent | null {
    const top = event.exception?.values[0]?.stacktrace?.frames[0];
    const deny = this.options.denyUrls ?? [];
    if (top?.filename && deny.some((p) => (typeof p === "string" ? top.filename!.includes(p) : p.test(top.filename!)))) {
      return null;
    }
    for (const exc of event.exception?.values ?? []) exc.stacktrace?.frames.forEach(markInApp);

    if (typeof navigator !== "undefined") {
      const ua = navigator.userAgent;
      event.contexts = { ...parseUserAgent(ua), ...event.contexts };
      if (typeof location !== "undefined") {
        event.request ??= {
          url: scrubUrl(location.href),
          headers: { "user-agent": ua, ...(document.referrer ? { referer: scrubUrl(document.referrer) } : {}) },
        };
      }
      if (typeof window !== "undefined") {
        event.contexts.device = { ...event.contexts.device, screen: `${window.screen?.width}x${window.screen?.height}`, viewport: `${window.innerWidth}x${window.innerHeight}` };
      }
    }
    return event;
  }
}

function markInApp(frame: StackFrame): void {
  if (frame.in_app !== undefined) return;
  const file = frame.filename ?? "";
  frame.in_app = /^(https?|file):/.test(file) && !/\/node_modules\/|-extension:\/\//.test(file);
}

/** Small UA parser: enough to group by browser / OS in the dashboard. */
export function parseUserAgent(ua: string): Record<string, Record<string, unknown>> {
  const contexts: Record<string, Record<string, unknown>> = {};
  const browser =
    match(ua, /Edg(?:e|A|iOS)?\/([\d.]+)/, "Edge") ??
    match(ua, /OPR\/([\d.]+)/, "Opera") ??
    match(ua, /SamsungBrowser\/([\d.]+)/, "Samsung Internet") ??
    match(ua, /Firefox\/([\d.]+)/, "Firefox") ??
    match(ua, /FxiOS\/([\d.]+)/, "Firefox") ??
    match(ua, /CriOS\/([\d.]+)/, "Chrome") ??
    match(ua, /Chrome\/([\d.]+)/, "Chrome") ??
    match(ua, /Version\/([\d.]+).*Safari/, "Safari");
  if (browser) contexts.browser = browser;
  const os =
    match(ua, /Windows NT ([\d.]+)/, "Windows") ??
    match(ua, /(?:iPhone|CPU) OS ([\d_]+)/, "iOS") ??
    match(ua, /Mac OS X ([\d_.]+)/, "macOS") ??
    match(ua, /Android ([\d.]+)/, "Android") ??
    (/CrOS/.test(ua) ? { name: "Chrome OS" } : /Linux/.test(ua) ? { name: "Linux" } : undefined);
  if (os) contexts.os = os;
  contexts.device = { family: /Mobi|Android|iPhone/.test(ua) ? "Mobile" : /iPad|Tablet/.test(ua) ? "Tablet" : "Desktop" };
  return contexts;
}

function match(ua: string, re: RegExp, name: string): { name: string; version: string } | undefined {
  const m = re.exec(ua);
  return m ? { name, version: m[1].replace(/_/g, ".").split(".").slice(0, 2).join(".") } : undefined;
}

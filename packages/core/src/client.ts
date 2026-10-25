import { ingestUrl, parseDsn } from "./dsn";
import { exceptionFromThrown } from "./exception";
import { Scope } from "./scope";
import type { Breadcrumb, BugfreeEvent, CaptureContext, ClientOptions, EventHint, Level, Transport } from "./types";
import { getWaitUntil, nowIso, uuid4 } from "./utils";

export const SDK_VERSION = "0.1.0";
const CAPTURED = Symbol.for("bugfree.captured");
const DEDUPE_WINDOW_MS = 2000;
const DEFAULT_MAX_EVENTS_PER_MINUTE = 300;

export interface TransportResult {
  status: number;
  /** Seconds to back off, from a 429 response. */
  retryAfter?: number;
}

export interface BaseTransport extends Transport {
  send(event: BugfreeEvent): Promise<TransportResult | void>;
}

/** Shared capture pipeline; platform clients add contexts, frame processing and integrations. */
export abstract class BaseClient<O extends ClientOptions = ClientOptions> {
  readonly options: O;
  lastEventId?: string;
  protected globalScope: Scope;
  protected transport?: BaseTransport;
  protected abstract readonly sdkName: string;
  protected abstract readonly platform: BugfreeEvent["platform"];
  private pending = new Set<Promise<unknown>>();
  private scopeProvider?: () => Scope | undefined;
  private lastSignature?: { sig: string; at: number };
  private rateLimitedUntil = 0;
  private windowStart = 0;
  private windowCount = 0;

  constructor(options: O) {
    this.options = { maxBreadcrumbs: 100, sampleRate: 1, ...options };
    this.globalScope = new Scope(this.options.maxBreadcrumbs);
    if (options.initialTags) this.globalScope.setTags(options.initialTags);
    if (this.options.enabled !== false && (options.transport || options.dsn)) {
      try {
        this.transport = (options.transport as BaseTransport | undefined) ?? this.createTransport(ingestUrl(parseDsn(options.dsn!)));
      } catch (err) {
        console.warn(String(err instanceof Error ? err.message : err));
      }
    }
  }

  /** Creates the default HTTP transport for the given ingest URL. */
  protected abstract createTransport(url: string): BaseTransport;

  /** Platform hook: add contexts, mark in-app frames, attach source context, … Return null to drop the event. */
  protected prepareEvent(event: BugfreeEvent, _hint: EventHint): BugfreeEvent | null | Promise<BugfreeEvent | null> {
    return event;
  }

  isEnabled(): boolean {
    return !!this.transport;
  }

  getScope(): Scope {
    return this.scopeProvider?.() ?? this.globalScope;
  }

  getGlobalScope(): Scope {
    return this.globalScope;
  }

  /** Lets a platform supply the active scope (e.g. a per-request scope from AsyncLocalStorage). */
  setScopeProvider(provider: () => Scope | undefined): void {
    this.scopeProvider = provider;
  }

  /** Runs `callback` with a forked scope. Synchronous isolation only; Node overrides this with async isolation. */
  withScope<T>(callback: (scope: Scope) => T): T {
    const previous = this.globalScope;
    const forked = previous.clone();
    this.globalScope = forked;
    try {
      return callback(forked);
    } finally {
      this.globalScope = previous;
    }
  }

  captureException(thrown: unknown, context?: CaptureContext): string {
    if (thrown && typeof thrown === "object") {
      const already = (thrown as Record<symbol, string>)[CAPTURED];
      if (already) return already;
    }
    const eventId = uuid4();
    if (thrown && typeof thrown === "object") {
      try {
        Object.defineProperty(thrown, CAPTURED, { value: eventId, enumerable: false, configurable: true });
      } catch {
        // frozen object
      }
    }
    const mechanism = context?.mechanism ?? { type: "generic", handled: true };
    this.captureEvent(
      {
        event_id: eventId,
        level: context?.level ?? (mechanism.handled ? "error" : "fatal"),
        exception: { values: exceptionFromThrown(thrown, mechanism) },
      },
      { originalException: thrown, mechanism },
      context,
    );
    return eventId;
  }

  captureMessage(message: string, levelOrContext: Level | CaptureContext = "info"): string {
    const context = typeof levelOrContext === "string" ? { level: levelOrContext } : levelOrContext;
    const eventId = uuid4();
    this.captureEvent({ event_id: eventId, level: context.level ?? "info", message }, {}, context);
    return eventId;
  }

  /** Builds the event from the active scope synchronously, then processes and sends it in the background. */
  captureEvent(partial: Partial<BugfreeEvent>, hint: EventHint = {}, context?: CaptureContext): string {
    const eventId = partial.event_id ?? uuid4();
    if (!this.transport) return eventId;
    const scope = this.getScope();
    const event: BugfreeEvent = {
      event_id: eventId,
      timestamp: nowIso(),
      platform: this.platform,
      level: "error",
      environment: this.options.environment,
      release: this.options.release,
      sdk: { name: this.sdkName, version: SDK_VERSION },
      ...partial,
      transaction: context?.transaction ?? partial.transaction ?? scope.transaction,
      request: context?.request ?? partial.request ?? scope.request,
      user: { ...scope.user, ...partial.user, ...context?.user },
      tags: { ...scope.tags, ...partial.tags, ...context?.tags },
      extra: { ...scope.extra, ...partial.extra, ...context?.extra },
      contexts: { ...scope.contexts, ...partial.contexts, ...context?.contexts },
      breadcrumbs: [...scope.breadcrumbs],
      fingerprint: context?.fingerprint ?? partial.fingerprint ?? scope.fingerprint,
    };
    if (event.user && Object.keys(event.user).length === 0) delete event.user;
    this.lastEventId = eventId;
    this.track(this.process(event, hint));
    return eventId;
  }

  addBreadcrumb(breadcrumb: Omit<Breadcrumb, "timestamp"> & { timestamp?: string }): void {
    let crumb: Breadcrumb | null = { timestamp: nowIso(), ...breadcrumb };
    if (this.options.beforeBreadcrumb) {
      try {
        crumb = this.options.beforeBreadcrumb(crumb);
      } catch {
        // keep the original breadcrumb if the hook throws
      }
    }
    if (crumb) this.getScope().addBreadcrumb(crumb);
  }

  /** Resolves true once all queued events are sent, false on timeout. */
  async flush(timeoutMs = 2000): Promise<boolean> {
    if (!this.pending.size) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const done = Promise.allSettled([...this.pending]).then(() => true);
    const result = await Promise.race([done, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }

  protected log(...args: unknown[]): void {
    if (this.options.debug) console.log("[bugfree]", ...args);
  }

  private track(promise: Promise<unknown>): void {
    this.pending.add(promise);
    promise.finally(() => this.pending.delete(promise)).catch(() => {});
    // Serverless runtimes (Vercel, Next.js on Node/edge) may freeze right after the response;
    // registering the send keeps the function alive until it completes.
    const waitUntil = getWaitUntil();
    if (waitUntil) {
      try {
        waitUntil(promise.catch(() => {}));
      } catch {
        // outside a request scope
      }
    }
  }

  private async process(event: BugfreeEvent, hint: EventHint): Promise<void> {
    try {
      const reason = this.shouldDrop(event);
      if (reason) {
        this.log(`Dropped event ${event.event_id}: ${reason}`);
        return;
      }
      let prepared: BugfreeEvent | null = await this.prepareEvent(event, hint);
      if (prepared && this.options.beforeSend) prepared = await this.options.beforeSend(prepared, hint);
      if (!prepared) {
        this.log(`Event ${event.event_id} dropped by prepareEvent/beforeSend`);
        return;
      }
      const result = await this.transport!.send(prepared);
      if (result && result.status === 429) {
        this.rateLimitedUntil = Date.now() + (result.retryAfter ?? 60) * 1000;
      }
      if (result && result.status >= 400) this.log(`Server rejected event ${event.event_id} with HTTP ${result.status}`);
      else this.log(`Sent event ${event.event_id}`);
    } catch (err) {
      this.log("Failed to send event", err);
    }
  }

  private shouldDrop(event: BugfreeEvent): string | null {
    const now = Date.now();
    if (now < this.rateLimitedUntil) return "rate limited by server";
    if (this.options.sampleRate! < 1 && Math.random() >= this.options.sampleRate!) return "sampled out";

    const primary = event.exception?.values[0];
    const text = primary ? `${primary.type}: ${primary.value}` : (event.message ?? "");
    for (const pattern of this.options.ignoreErrors ?? []) {
      if (typeof pattern === "string" ? text.includes(pattern) : pattern.test(text)) return "matched ignoreErrors";
    }

    const top = primary?.stacktrace?.frames[0];
    const sig = `${text}|${top?.filename}:${top?.lineno}:${top?.colno}`;
    if (this.options.dedupe && this.lastSignature && this.lastSignature.sig === sig && now - this.lastSignature.at < DEDUPE_WINDOW_MS) {
      return "duplicate of the previous event";
    }
    this.lastSignature = { sig, at: now };

    if (now - this.windowStart > 60_000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    if (++this.windowCount > DEFAULT_MAX_EVENTS_PER_MINUTE) return "client-side limit of events per minute";
    return null;
  }
}

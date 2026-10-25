import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BaseClient,
  type BaseTransport,
  type BugfreeEvent,
  type ClientOptions,
  type EventHint,
  Scope,
  type StackFrame,
  type TransportResult,
} from "@dwarelab/bugfree-core";
import { addContextLines } from "./context-lines";
import { detectRelease } from "./release";

export interface NodeOptions extends ClientOptions {
  /** Server name sent with every event. Defaults to the hostname. */
  serverName?: string;
  /** Capture uncaught exceptions (and exit like Node would). Default true. */
  captureUncaughtExceptions?: boolean;
  /**
   * Capture unhandled promise rejections. "warn" logs and keeps running, "strict" exits
   * the process after reporting, "none" disables the handler. Default "warn".
   */
  unhandledRejections?: "warn" | "strict" | "none";
  /** Record console calls as breadcrumbs. Default true. */
  consoleBreadcrumbs?: boolean;
  /** Record outgoing fetch() calls as breadcrumbs. Default true. */
  fetchBreadcrumbs?: boolean;
  /** Record outgoing http/https requests (axios, got, node-fetch …) as breadcrumbs. Default true. */
  httpBreadcrumbs?: boolean;
  /** Deliver queued events before the process exits on SIGTERM / SIGINT. Default true. */
  flushOnShutdown?: boolean;
  /** Read source files to show code around in-app frames. Default true. */
  includeSourceContext?: boolean;
}

const requestScope = new AsyncLocalStorage<Scope>();

class NodeTransport implements BaseTransport {
  constructor(readonly url: string) {}

  async send(event: BugfreeEvent): Promise<TransportResult> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10_000),
    });
    const retryAfter = Number(res.headers.get("retry-after")) || undefined;
    await res.arrayBuffer().catch(() => undefined);
    return { status: res.status, retryAfter };
  }
}

export class NodeClient extends BaseClient<NodeOptions> {
  protected readonly sdkName = "bugfree.node";
  protected readonly platform = "node" as const;
  readonly ingestUrl?: string;

  constructor(options: NodeOptions) {
    super({
      environment: process.env.BUGFREE_ENVIRONMENT ?? process.env.NODE_ENV ?? "production",
      ...options,
      release: options.release ?? detectRelease(),
    });
    this.ingestUrl = (this.transport as NodeTransport | undefined)?.url;
    this.setScopeProvider(() => requestScope.getStore());
  }

  protected createTransport(url: string): BaseTransport {
    return new NodeTransport(url);
  }

  /** Runs `callback` with a scope isolated to its async context (the whole request, including awaits). */
  override withScope<T>(callback: (scope: Scope) => T): T {
    const scope = this.getScope().clone();
    return requestScope.run(scope, () => callback(scope));
  }

  protected override async prepareEvent(event: BugfreeEvent, _hint: EventHint): Promise<BugfreeEvent> {
    event.server_name ??= this.options.serverName ?? os.hostname();
    event.contexts = {
      runtime: { name: "node", version: process.version },
      os: { name: os.type(), version: os.release(), arch: os.arch() },
      app: { memory_rss: process.memoryUsage().rss, uptime: Math.round(process.uptime()) },
      ...event.contexts,
    };
    for (const exc of event.exception?.values ?? []) {
      const frames = exc.stacktrace?.frames ?? [];
      frames.forEach(normalizeFrame);
      if (this.options.includeSourceContext !== false) await addContextLines(frames);
    }
    return event;
  }
}

const cwd = process.cwd();

function normalizeFrame(frame: StackFrame): void {
  let file = frame.abs_path ?? frame.filename;
  if (!file) return;
  if (file.startsWith("file://")) {
    try {
      file = fileURLToPath(file);
    } catch {
      // leave as-is
    }
  }
  frame.abs_path = file;
  const isInternal = file.startsWith("node:") || !path.isAbsolute(file);
  frame.in_app ??= !isInternal && !file.includes(`${path.sep}node_modules${path.sep}`);
  frame.filename = !isInternal && file.startsWith(cwd + path.sep) ? path.relative(cwd, file) : file;
}

/** Runs `callback` inside a fresh per-request scope forked from the global one. */
export function runWithRequestScope<T>(client: NodeClient | undefined, callback: (scope: Scope | undefined) => T): T {
  if (!client) return callback(undefined);
  const scope = client.getGlobalScope().clone();
  return requestScope.run(scope, () => callback(scope));
}

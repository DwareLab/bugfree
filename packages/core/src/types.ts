export type Level = "fatal" | "error" | "warning" | "info" | "debug";

export interface StackFrame {
  /** Path or URL of the file, as reported by the runtime (or mapped source path after symbolication). */
  filename?: string;
  /** Unmodified path or URL as it appeared in the stack. */
  abs_path?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
  pre_context?: string[];
  context_line?: string;
  post_context?: string[];
}

export interface Mechanism {
  /** Where the error was caught, e.g. "onerror", "express", "nextjs.onRequestError". */
  type: string;
  /** false when the error was not caught by application code. */
  handled: boolean;
  data?: Record<string, unknown>;
}

export interface ExceptionValue {
  type: string;
  value: string;
  /** Innermost (throwing) frame first. */
  stacktrace?: { frames: StackFrame[] };
  mechanism?: Mechanism;
}

export interface Breadcrumb {
  timestamp: string;
  type?: "default" | "http" | "navigation" | "ui" | "console" | "error";
  category?: string;
  message?: string;
  level?: Level;
  data?: Record<string, unknown>;
}

export interface User {
  id?: string;
  email?: string;
  username?: string;
  ip_address?: string;
  [key: string]: unknown;
}

export interface RequestInfo {
  method?: string;
  url?: string;
  query_string?: string;
  headers?: Record<string, string>;
  data?: unknown;
}

export interface BugfreeEvent {
  event_id: string;
  timestamp: string;
  platform: "node" | "javascript";
  level: Level;
  environment?: string;
  release?: string;
  server_name?: string;
  /** Route-like name of what was running, e.g. "GET /users/:id". */
  transaction?: string;
  message?: string;
  /** Primary error first, followed by its `cause` chain. */
  exception?: { values: ExceptionValue[] };
  breadcrumbs?: Breadcrumb[];
  request?: RequestInfo;
  user?: User;
  tags?: Record<string, string>;
  contexts?: Record<string, Record<string, unknown>>;
  extra?: Record<string, unknown>;
  /** Custom grouping. Use "{{ default }}" to extend the default fingerprint. */
  fingerprint?: string[];
  sdk?: { name: string; version: string };
}

export interface EventHint {
  originalException?: unknown;
  mechanism?: Mechanism;
}

export interface CaptureContext {
  level?: Level;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  user?: User;
  fingerprint?: string[];
  contexts?: Record<string, Record<string, unknown>>;
  transaction?: string;
  request?: RequestInfo;
  mechanism?: Mechanism;
}

export interface Transport {
  send(event: BugfreeEvent): Promise<void>;
}

export interface ClientOptions {
  /** e.g. https://<publicKey>@api.example.com/<projectId>. When missing, the SDK is disabled. */
  dsn?: string;
  enabled?: boolean;
  environment?: string;
  release?: string;
  /** 0..1 — fraction of error events to send. */
  sampleRate?: number;
  maxBreadcrumbs?: number;
  /** Drop an event identical to the previous one within 2s (guards against render/retry loops). */
  dedupe?: boolean;
  /** Errors whose message matches any of these are dropped. */
  ignoreErrors?: Array<string | RegExp>;
  /** Mutate or drop (return null) an event right before it is sent. */
  beforeSend?: (event: BugfreeEvent, hint: EventHint) => BugfreeEvent | null | Promise<BugfreeEvent | null>;
  beforeBreadcrumb?: (breadcrumb: Breadcrumb) => Breadcrumb | null;
  /** Initial tags applied to every event. */
  initialTags?: Record<string, string>;
  /** Log SDK internals to the console. */
  debug?: boolean;
  /** Override how events are delivered (tests, custom proxies). */
  transport?: Transport;
}

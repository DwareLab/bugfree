"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4100").replace(/\/+$/, "");

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Calls the bugfree API directly (its own origin) with the session cookie. */
export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const serverError = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : "";
    const message = serverError || `Request failed (${res.status})`;
    if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth/")) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    }
    throw new ApiError(res.status, message);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface UseApi<T> {
  data: T | undefined;
  error: ApiError | Error | undefined;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (updater: T | ((prev: T | undefined) => T)) => void;
}

/** Fetches `path` (null = skip) and refetches when it changes. Keeps stale data while reloading. */
export function useApi<T>(path: string | null, options: { refreshMs?: number } = {}): UseApi<T> {
  const [data, setDataState] = useState<T>();
  const [error, setError] = useState<ApiError | Error>();
  const [loading, setLoading] = useState(!!path);
  const current = useRef(path);
  current.current = path;

  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      const result = await api<T>(path);
      if (current.current === path) {
        setDataState(result);
        setError(undefined);
      }
    } catch (err) {
      if (current.current === path) setError(err as Error);
    } finally {
      if (current.current === path) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!options.refreshMs || !path) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, options.refreshMs);
    return () => clearInterval(t);
  }, [load, options.refreshMs, path]);

  const setData = useCallback((updater: T | ((prev: T | undefined) => T)) => {
    setDataState((prev) => (typeof updater === "function" ? (updater as (p: T | undefined) => T)(prev) : updater));
  }, []);

  return { data, error, loading, reload: load, setData };
}

// ---- API types ----

export interface User {
  id: number;
  email: string;
}

export interface ProjectSummary {
  id: number;
  name: string;
  platform: string;
  created_at: string;
  unresolved_issues: number;
  events_24h: number;
  last_event_at: string | null;
}

export interface Project {
  id: number;
  name: string;
  platform: "nextjs" | "express" | "node" | "browser";
  public_key: string;
  secret_key: string;
  dsn: string;
  api_url: string;
  alert_webhook_url: string | null;
  alert_emails: string | null;
  alert_on_new: boolean;
  alert_on_regression: boolean;
  created_at: string;
}

export type IssueStatus = "unresolved" | "resolved" | "ignored";
export type Level = "fatal" | "error" | "warning" | "info" | "debug";

export interface IssueRow {
  id: number;
  title: string;
  culprit: string | null;
  type: string | null;
  level: Level;
  status: IssueStatus;
  platform: string;
  times_seen: number;
  users_count: number;
  first_seen: string;
  last_seen: string;
  first_release: string | null;
  last_release: string | null;
  hourly: number[];
}

export interface IssueList {
  total: number;
  offset: number;
  pageSize: number;
  issues: IssueRow[];
}

export interface Point {
  t: string;
  count: number;
}

export interface IssueDetail extends Omit<IssueRow, "hourly"> {
  project_id: number;
  project_name: string;
  value: string | null;
  resolved_at: string | null;
  latest_event_id: number | null;
  oldest_event_id: number | null;
  stored_events: number;
  tags: Record<string, { total: number; values: Array<{ value: string; count: number }> }>;
  stats: { hourly: Point[]; daily: Point[] };
}

export interface Frame {
  filename?: string;
  abs_path?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
  pre_context?: string[];
  context_line?: string;
  post_context?: string[];
  mapped?: boolean;
  raw_filename?: string;
  raw_function?: string;
  raw_lineno?: number;
  raw_colno?: number;
}

export interface ExceptionValue {
  type: string;
  value: string;
  stacktrace?: { frames: Frame[] };
  mechanism?: { type: string; handled: boolean; data?: Record<string, unknown> };
}

export interface Breadcrumb {
  timestamp: string;
  type?: string;
  category?: string;
  message?: string;
  level?: Level;
  data?: Record<string, unknown>;
}

export interface EventData {
  event_id: string;
  timestamp?: string;
  platform: string;
  level: Level;
  environment?: string;
  release?: string;
  server_name?: string;
  transaction?: string;
  message?: string;
  exception?: { values: ExceptionValue[] };
  breadcrumbs?: Breadcrumb[];
  request?: { method?: string; url?: string; query_string?: string; headers?: Record<string, string>; data?: unknown };
  user?: Record<string, unknown>;
  tags?: Record<string, string>;
  contexts?: Record<string, Record<string, unknown>>;
  extra?: Record<string, unknown>;
  sdk?: { name: string; version: string };
  fingerprint?: string[];
}

export interface StoredEvent {
  id: number;
  event_id: string;
  issue_id: number;
  occurred_at: string;
  received_at: string;
  level: Level;
  environment: string | null;
  release: string | null;
  transaction_name: string | null;
  message: string | null;
  data: EventData;
  prev_id: number | null;
  next_id: number | null;
}

export interface EventRow {
  id: number;
  event_id: string;
  occurred_at: string;
  environment: string | null;
  release: string | null;
  transaction_name: string | null;
  message: string | null;
  user_key: string | null;
  url: string | null;
  browser: string | null;
}

export interface Release {
  version: string;
  created_at: string;
  artifact_count: number;
  artifact_bytes: number;
  new_issues: number;
  events: number;
}

export interface Artifact {
  id: number;
  name: string;
  size: number;
  created_at: string;
}

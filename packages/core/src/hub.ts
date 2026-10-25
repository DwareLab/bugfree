import type { BaseClient } from "./client";
import type { Scope } from "./scope";
import type { Breadcrumb, CaptureContext, Level, User } from "./types";

// Stored on globalThis so every bundled copy of the SDK (e.g. Next.js server chunks) shares one client.
const KEY = Symbol.for("bugfree.client");
type GlobalWithClient = typeof globalThis & { [KEY]?: BaseClient };

export function setCurrentClient(client: BaseClient | undefined): void {
  (globalThis as GlobalWithClient)[KEY] = client;
}

export function getClient<C extends BaseClient = BaseClient>(): C | undefined {
  return (globalThis as GlobalWithClient)[KEY] as C | undefined;
}

export function captureException(thrown: unknown, context?: CaptureContext): string | undefined {
  return getClient()?.captureException(thrown, context);
}

export function captureMessage(message: string, levelOrContext?: Level | CaptureContext): string | undefined {
  return getClient()?.captureMessage(message, levelOrContext);
}

export function addBreadcrumb(breadcrumb: Omit<Breadcrumb, "timestamp"> & { timestamp?: string }): void {
  getClient()?.addBreadcrumb(breadcrumb);
}

export function setUser(user: User | null): void {
  getClient()?.getScope().setUser(user);
}

export function setTag(key: string, value: string | number | boolean): void {
  getClient()?.getScope().setTag(key, value);
}

export function setTags(tags: Record<string, string | number | boolean>): void {
  getClient()?.getScope().setTags(tags);
}

export function setExtra(key: string, value: unknown): void {
  getClient()?.getScope().setExtra(key, value);
}

export function setContext(name: string, context: Record<string, unknown> | null): void {
  getClient()?.getScope().setContext(name, context);
}

export function withScope<T>(callback: (scope: Scope | undefined) => T): T {
  const client = getClient();
  return client ? client.withScope(callback) : callback(undefined);
}

export function lastEventId(): string | undefined {
  return getClient()?.lastEventId;
}

export function flush(timeoutMs?: number): Promise<boolean> {
  return getClient()?.flush(timeoutMs) ?? Promise.resolve(true);
}

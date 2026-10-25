import type { Breadcrumb, RequestInfo, User } from "./types";

/** Context attached to every event captured while the scope is active. */
export class Scope {
  user?: User;
  tags: Record<string, string> = {};
  extra: Record<string, unknown> = {};
  contexts: Record<string, Record<string, unknown>> = {};
  breadcrumbs: Breadcrumb[] = [];
  fingerprint?: string[];
  transaction?: string;
  request?: RequestInfo;

  constructor(private maxBreadcrumbs = 100) {}

  clone(): Scope {
    const s = new Scope(this.maxBreadcrumbs);
    s.user = this.user && { ...this.user };
    s.tags = { ...this.tags };
    s.extra = { ...this.extra };
    s.contexts = { ...this.contexts };
    s.breadcrumbs = [...this.breadcrumbs];
    s.fingerprint = this.fingerprint && [...this.fingerprint];
    s.transaction = this.transaction;
    s.request = this.request && { ...this.request };
    return s;
  }

  setUser(user: User | null): void {
    this.user = user ?? undefined;
  }

  setTag(key: string, value: string | number | boolean): void {
    this.tags[key] = String(value);
  }

  setTags(tags: Record<string, string | number | boolean>): void {
    for (const [k, v] of Object.entries(tags)) this.setTag(k, v);
  }

  setExtra(key: string, value: unknown): void {
    this.extra[key] = value;
  }

  setContext(name: string, context: Record<string, unknown> | null): void {
    if (context === null) delete this.contexts[name];
    else this.contexts[name] = context;
  }

  setFingerprint(fingerprint: string[] | undefined): void {
    this.fingerprint = fingerprint;
  }

  setTransaction(name: string | undefined): void {
    this.transaction = name;
  }

  setRequest(request: RequestInfo | undefined): void {
    this.request = request;
  }

  addBreadcrumb(breadcrumb: Breadcrumb): void {
    this.breadcrumbs.push(breadcrumb);
    if (this.breadcrumbs.length > this.maxBreadcrumbs) {
      this.breadcrumbs.splice(0, this.breadcrumbs.length - this.maxBreadcrumbs);
    }
  }

  clearBreadcrumbs(): void {
    this.breadcrumbs = [];
  }
}

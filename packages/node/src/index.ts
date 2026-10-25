import { getClient, setCurrentClient } from "@bugfree/core";
import { NodeClient, type NodeOptions } from "./client";
import {
  installConsoleBreadcrumbs,
  installFetchBreadcrumbs,
  installUncaughtExceptionHandler,
  installUnhandledRejectionHandler,
} from "./integrations";

export {
  addBreadcrumb,
  captureException,
  captureMessage,
  flush,
  getClient,
  lastEventId,
  setContext,
  setExtra,
  setTag,
  setTags,
  setUser,
  withScope,
  Scope,
  type BugfreeEvent,
  type Breadcrumb,
  type CaptureContext,
  type Level,
  type User,
} from "@bugfree/core";
export { NodeClient, runWithRequestScope, type NodeOptions } from "./client";

const INSTALLED = Symbol.for("bugfree.node.installed");

/** Initializes the SDK. Safe to call more than once; later calls replace the client. */
export function init(options: NodeOptions = {}): NodeClient {
  const client = new NodeClient({ dsn: process.env.BUGFREE_DSN, ...options });
  setCurrentClient(client);

  // Process-wide hooks are installed once and always report to the current client.
  const g = globalThis as { [INSTALLED]?: boolean };
  if (!g[INSTALLED] && client.isEnabled()) {
    g[INSTALLED] = true;
    const current = () => (getClient() as NodeClient | undefined) ?? client;
    if (options.captureUncaughtExceptions !== false) installUncaughtExceptionHandler(current);
    const rejections = options.unhandledRejections ?? "warn";
    if (rejections !== "none") installUnhandledRejectionHandler(current, rejections);
    if (options.consoleBreadcrumbs !== false) installConsoleBreadcrumbs(current);
    if (options.fetchBreadcrumbs !== false) installFetchBreadcrumbs(current);
  }
  return client;
}

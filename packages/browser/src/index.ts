import { getClient, setCurrentClient } from "@dwarelab/bugfree-core";
import { BrowserClient, type BrowserOptions } from "./client";
import {
  installConsoleBreadcrumbs,
  installDomBreadcrumbs,
  installFetchBreadcrumbs,
  installGlobalHandlers,
  installHistoryBreadcrumbs,
  installXhrBreadcrumbs,
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
  type BugfreeEvent,
  type Breadcrumb,
  type CaptureContext,
  type Level,
  type User,
} from "@dwarelab/bugfree-core";
export { BrowserClient, parseUserAgent, type BrowserOptions } from "./client";

const INSTALLED = Symbol.for("bugfree.browser.installed");

/** Initializes the SDK in the browser. Safe to call more than once; later calls replace the client. */
export function init(options: BrowserOptions = {}): BrowserClient {
  const client = new BrowserClient(options);
  setCurrentClient(client);
  if (typeof window === "undefined") return client;

  const w = window as unknown as { [INSTALLED]?: boolean };
  if (!w[INSTALLED] && client.isEnabled()) {
    w[INSTALLED] = true;
    const current = () => (getClient() as BrowserClient | undefined) ?? client;
    const crumbs = options.breadcrumbs ?? {};
    if (options.globalHandlers !== false) installGlobalHandlers(current);
    if (crumbs.console !== false) installConsoleBreadcrumbs(current);
    if (crumbs.dom !== false) installDomBreadcrumbs(current);
    if (crumbs.history !== false) installHistoryBreadcrumbs(current);
    if (crumbs.fetch !== false) installFetchBreadcrumbs(current);
    if (crumbs.xhr !== false) installXhrBreadcrumbs(current);
    // Deliver queued events when the tab is hidden or closed.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void current().flush(1000);
    });
  }
  return client;
}

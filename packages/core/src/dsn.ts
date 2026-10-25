export interface Dsn {
  publicKey: string;
  projectId: string;
  /** Base URL of the API, e.g. https://api.example.com (may include a path prefix). */
  apiUrl: string;
}

/** Parses `https://<publicKey>@api.example.com[/prefix]/<projectId>`. */
export function parseDsn(dsn: string): Dsn {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error(`[bugfree] Invalid DSN: ${dsn}`);
  }
  const publicKey = decodeURIComponent(url.username);
  const segments = url.pathname.split("/").filter(Boolean);
  const projectId = segments.pop();
  if (!publicKey || !projectId) {
    throw new Error(`[bugfree] Invalid DSN (missing key or project id): ${dsn}`);
  }
  const prefix = segments.length ? `/${segments.join("/")}` : "";
  return { publicKey, projectId, apiUrl: `${url.protocol}//${url.host}${prefix}` };
}

export function ingestUrl(dsn: Dsn): string {
  return `${dsn.apiUrl}/api/ingest/${encodeURIComponent(dsn.projectId)}?key=${encodeURIComponent(dsn.publicKey)}`;
}

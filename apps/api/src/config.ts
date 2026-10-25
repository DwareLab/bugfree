function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const isProd = process.env.NODE_ENV === "production";

export const config = {
  isProd,
  port: Number(process.env.PORT ?? 4100),
  /** Read on first use: the Cloudflare Worker connects through its Hyperdrive binding instead. */
  get databaseUrl(): string {
    return required("DATABASE_URL", isProd ? undefined : "postgres://bugfree:bugfree@localhost:5442/bugfree");
  },
  /** Public URL of this API; shown in DSNs. */
  apiUrl: required("API_URL", isProd ? undefined : "http://localhost:4100").replace(/\/+$/, ""),
  /** Dashboard origin(s), comma-separated. The first one is used in alert links. */
  appUrls: required("APP_URL", isProd ? undefined : "http://localhost:3100")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean),
  /** e.g. ".example.com" so the session cookie is shared by app. and api. subdomains. */
  cookieDomain: process.env.COOKIE_DOMAIN || undefined,
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : isProd,
  sessionDays: Number(process.env.SESSION_DAYS ?? 30),
  retentionDays: Number(process.env.RETENTION_DAYS ?? 30),
  /** Max events per second per project (burst = 10x). */
  ingestRateLimit: Number(process.env.INGEST_RATE_LIMIT ?? 50),
  /** Log lines are kept for this long (they are much bulkier than events). */
  logRetentionDays: Number(process.env.LOG_RETENTION_DAYS ?? 14),
  /** Source maps of a release are deleted once it has had no uploads or events for this long… */
  artifactRetentionDays: Number(process.env.ARTIFACT_RETENTION_DAYS ?? 90),
  /** …except for each project's newest releases, which always keep theirs. */
  artifactKeepReleases: Number(process.env.ARTIFACT_KEEP_RELEASES ?? 5),
  /** Max log lines per second per project (burst = 10x). */
  logRateLimit: Number(process.env.LOG_RATE_LIMIT ?? 2000),
  /** Parsed source maps kept in memory for symbolication (lower on Workers, which have 128 MB). */
  sourceMapCacheSize: Number(process.env.SOURCEMAP_CACHE_SIZE ?? 30),
  smtpUrl: process.env.SMTP_URL || undefined,
  alertFrom: process.env.ALERT_FROM ?? "bugfree <alerts@localhost>",
  /** Set when running behind a reverse proxy so req.ip / req.protocol are correct. */
  trustProxy: process.env.TRUST_PROXY ?? (isProd ? "1" : "0"),
};

export type Config = typeof config;

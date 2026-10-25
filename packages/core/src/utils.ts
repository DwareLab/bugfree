export function uuid4(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  let out = "";
  for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

export function truncate(str: string, max: number): string {
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

const SENSITIVE_KEY = /pass(word|wd)?|secret|token|auth|api[-_]?key|session|cookie|card|cvv|ssn|credential/i;
export const FILTERED = "[Filtered]";

/**
 * JSON-safe copy of `value`: limits depth, breadth and string length,
 * replaces circular references, and filters values of sensitive-looking keys.
 */
export function normalize(value: unknown, depth = 5, maxKeys = 100): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, d: number, key?: string): unknown => {
    if (key && SENSITIVE_KEY.test(key) && v != null && typeof v !== "object") return FILTERED;
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
    if (typeof v === "string") return truncate(v, 2000);
    if (typeof v === "bigint") return `${v}n`;
    if (typeof v === "undefined") return "[undefined]";
    if (typeof v === "symbol") return v.toString();
    if (typeof v === "function") return `[Function: ${v.name || "anonymous"}]`;
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack && truncate(v.stack, 4000) };
    if (typeof v !== "object") return String(v);
    if (seen.has(v)) return "[Circular]";
    if (d <= 0) return Array.isArray(v) ? "[Array]" : "[Object]";
    seen.add(v);
    if (Array.isArray(v)) {
      const arr = v.slice(0, maxKeys).map((x) => walk(x, d - 1));
      if (v.length > maxKeys) arr.push(`[${v.length - maxKeys} more items]`);
      return arr;
    }
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const k of Object.keys(v)) {
      if (n++ >= maxKeys) {
        out["…"] = "[more keys]";
        break;
      }
      out[k] = walk((v as Record<string, unknown>)[k], d - 1, k);
    }
    return out;
  };
  return walk(value, depth);
}

/** Drops headers that carry credentials. */
export function scrubHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    const lower = k.toLowerCase();
    if (lower === "cookie" || lower === "set-cookie" || lower === "authorization" || lower === "proxy-authorization" || SENSITIVE_KEY.test(lower)) {
      out[lower] = FILTERED;
      continue;
    }
    out[lower] = truncate(Array.isArray(v) ? v.join(", ") : String(v), 1000);
  }
  return out;
}

/** Removes sensitive query parameters from a URL or query string. */
export function scrubUrl(url: string): string {
  return url.replace(/([?&])([^=&#]+)=([^&#]*)/g, (all, sep: string, key: string) =>
    SENSITIVE_KEY.test(decodeURIComponentSafe(key)) ? `${sep}${key}=${FILTERED}` : all,
  );
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function isError(value: unknown): value is Error {
  return (
    value instanceof Error ||
    (typeof value === "object" && value !== null && typeof (value as Error).message === "string" && typeof (value as Error).stack === "string")
  );
}

export function nowIso(): string {
  return new Date().toISOString();
}

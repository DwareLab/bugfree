import { z } from "zod";

export const LOG_LEVELS = ["fatal", "error", "warning", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const MAX_MESSAGE = 16_384;
const meta = z.string().max(300).optional();

export const logBatchSchema = z.object({
  host: meta,
  logs: z
    .array(
      z.object({
        timestamp: z.union([z.string().max(64), z.number()]).optional(),
        message: z.string(),
        level: z.string().max(32).optional(),
        stream: z.enum(["stdout", "stderr"]).optional(),
        host: meta,
        container: meta,
        service: meta,
        image: meta,
        container_id: meta,
        attributes: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1)
    .max(5000),
});

export type LogBatch = z.infer<typeof logBatchSchema>;
export type IncomingLog = LogBatch["logs"][number];

export interface NormalizedLog {
  ts: string;
  level: LogLevel;
  stream: string | null;
  host: string | null;
  container: string | null;
  service: string | null;
  image: string | null;
  container_id: string | null;
  message: string;
  attributes: Record<string, unknown> | null;
}

const SYNONYMS: Record<string, LogLevel> = {
  fatal: "fatal", panic: "fatal", emerg: "fatal", emergency: "fatal", alert: "fatal", crit: "fatal", critical: "fatal",
  error: "error", err: "error", eror: "error",
  warning: "warning", warn: "warning", wrn: "warning",
  info: "info", inf: "info", notice: "info", log: "info", information: "info",
  debug: "debug", dbg: "debug", trace: "debug", verbose: "debug", silly: "debug",
};

/** pino / bunyan numeric levels. */
function numericLevel(n: number): LogLevel {
  if (n >= 60) return "fatal";
  if (n >= 50) return "error";
  if (n >= 40) return "warning";
  if (n >= 30) return "info";
  return "debug";
}

export function toLevel(value: unknown): LogLevel | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return numericLevel(value);
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (/^\d+$/.test(v)) return numericLevel(Number(v));
  return SYNONYMS[v];
}

const LEVEL_WORDS = "FATAL|PANIC|EMERG|CRIT(?:ICAL)?|ERROR|ERR|WARN(?:ING)?|INFO|NOTICE|LOG|DEBUG|TRACE";
const UPPER_WORD = new RegExp(`(?:^|[^A-Za-z])(${LEVEL_WORDS})(?![A-Za-z])`);
const LOGFMT = /\b(?:level|lvl|severity|loglevel)=["']?([A-Za-z]+|\d+)/i;
const BRACKETED = /[[<(]([A-Za-z]{3,8})[\]>)]/;
const LEADING = /^(error|err|warn|warning|info|debug|fatal|panic)\b[\s:|-]/i;
const EXCEPTION = /^(?:Uncaught |Unhandled )?\w*(?:Error|Exception)(?: \[\w+\])?:|^Traceback \(most recent call last\)|^panic: /;

/** Best-effort level of a plain-text line: logfmt `level=`, `[warn]`, `ERROR`, `Error: …`. */
export function detectLevel(line: string): LogLevel | undefined {
  const head = line.slice(0, 160);
  const fromLogfmt = LOGFMT.exec(head);
  if (fromLogfmt) {
    const level = toLevel(fromLogfmt[1]);
    if (level) return level;
  }
  const leading = LEADING.exec(head);
  if (leading) return toLevel(leading[1]);
  if (EXCEPTION.test(head)) return "error";
  const bracketed = BRACKETED.exec(head);
  if (bracketed) {
    const level = toLevel(bracketed[1]);
    if (level) return level;
  }
  // Upper-case only: a lower-case "error" inside a sentence is usually not a level.
  const upper = UPPER_WORD.exec(head);
  if (upper) return toLevel(upper[1]);
  return undefined;
}

// CSI sequences (colors, cursor moves) and OSC sequences (titles, hyperlinks).
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(s: string): string {
  return s.includes("\x1b") ? s.replace(ANSI, "") : s;
}

const MESSAGE_KEYS = ["msg", "message", "@message", "log", "text"];
const LEVEL_KEYS = ["level", "severity", "lvl", "levelname", "log.level", "@level", "loglevel"];
const TIME_KEYS = ["time", "timestamp", "ts", "@timestamp", "t", "datetime"];
const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

function timestamp(value: string | number | undefined, now: Date): string {
  if (typeof value === "string" && ISO.test(value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds or milliseconds since the epoch.
    const d = new Date(value < 1e12 ? value * 1000 : value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof value === "string") {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return now.toISOString();
}

/** Parses a JSON log line (pino, winston, bunyan, zap, logrus …) into message, level and the remaining fields. */
function structured(message: string): { message?: string; level?: LogLevel; attributes: Record<string, unknown> } | undefined {
  if (!message.startsWith("{") || !message.endsWith("}")) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(message);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const attributes = { ...(obj as Record<string, unknown>) };
  let msg: string | undefined;
  for (const key of MESSAGE_KEYS) {
    if (typeof attributes[key] === "string") {
      msg = attributes[key] as string;
      delete attributes[key];
      break;
    }
  }
  let level: LogLevel | undefined;
  for (const key of LEVEL_KEYS) {
    const l = toLevel(attributes[key]);
    if (l) {
      level = l;
      delete attributes[key];
      break;
    }
  }
  // The line's own time duplicates the collector's timestamp.
  for (const key of TIME_KEYS) if (key in attributes && (typeof attributes[key] === "string" || typeof attributes[key] === "number")) delete attributes[key];
  return { message: msg, level, attributes };
}

export function normalizeLog(line: IncomingLog, batchHost: string | undefined, now = new Date()): NormalizedLog {
  let message = stripAnsi(line.message).replace(/\r$/, "");
  let attributes: Record<string, unknown> | null = line.attributes && Object.keys(line.attributes).length ? { ...line.attributes } : null;
  let level = toLevel(line.level);

  const parsed = structured(message.trim());
  if (parsed) {
    if (parsed.message !== undefined) message = parsed.message;
    level ??= parsed.level;
    if (Object.keys(parsed.attributes).length) attributes = { ...parsed.attributes, ...attributes };
  }
  level ??= detectLevel(message) ?? "info";
  if (message.length > MAX_MESSAGE) message = `${message.slice(0, MAX_MESSAGE)}… [truncated ${message.length - MAX_MESSAGE} chars]`;

  return {
    ts: timestamp(line.timestamp, now),
    level,
    stream: line.stream ?? null,
    host: line.host ?? batchHost ?? null,
    container: line.container?.replace(/^\//, "") ?? null,
    service: line.service ?? null,
    image: line.image ?? null,
    container_id: line.container_id?.slice(0, 12) ?? null,
    message,
    attributes,
  };
}

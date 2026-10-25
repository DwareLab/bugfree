import { StringDecoder } from "node:string_decoder";

export type Stream = "stdout" | "stderr";

export interface RawLine {
  stream: Stream;
  /** RFC 3339 with nanoseconds, as Docker writes it (`timestamps=1`). */
  timestamp: string;
  message: string;
}

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Turns the body of `GET /containers/:id/logs?timestamps=1` into lines. Without a TTY Docker multiplexes stdout and
 * stderr into frames with an 8-byte header (stream type, 3 zero bytes, big-endian payload size); with a TTY the body
 * is the raw terminal output.
 */
export class LogStreamParser {
  private frames: Buffer = Buffer.alloc(0);
  private readonly decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  private readonly partial: Record<Stream, string> = { stdout: "", stderr: "" };

  constructor(
    private readonly tty: boolean,
    private readonly onLine: (line: RawLine) => void,
  ) {}

  push(chunk: Buffer): void {
    if (this.tty) {
      this.text("stdout", chunk);
      return;
    }
    this.frames = this.frames.length ? Buffer.concat([this.frames, chunk]) : chunk;
    while (this.frames.length >= 8) {
      const size = this.frames.readUInt32BE(4);
      if (this.frames.length < 8 + size) break;
      const type = this.frames[0];
      const payload = this.frames.subarray(8, 8 + size);
      this.frames = this.frames.subarray(8 + size);
      // 0 = stdin (never sent), 1 = stdout, 2 = stderr
      this.text(type === 2 ? "stderr" : "stdout", payload);
    }
  }

  /** Emits whatever is left without a trailing newline (the stream ended). */
  end(): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const rest = this.partial[stream] + this.decoders[stream].end();
      this.partial[stream] = "";
      if (rest) this.emit(stream, rest);
    }
  }

  private text(stream: Stream, bytes: Buffer): void {
    const parts = (this.partial[stream] + this.decoders[stream].write(bytes)).split("\n");
    this.partial[stream] = parts.pop() ?? "";
    for (const part of parts) this.emit(stream, part);
  }

  private emit(stream: Stream, line: string): void {
    const space = line.indexOf(" ");
    const head = space > 0 ? line.slice(0, space) : line;
    if (TS.test(head)) this.onLine({ stream, timestamp: head, message: space > 0 ? line.slice(space + 1).replace(/\r$/, "") : "" });
    else this.onLine({ stream, timestamp: new Date().toISOString(), message: line.replace(/\r$/, "") });
  }
}

export interface Entry extends RawLine {
  /** Timestamp of the last physical line folded into this entry (the resume cursor). */
  lastTimestamp: string;
}

const CONTINUATION = /^(?:[ \t]+\S|Caused by: |\s*\.\.\. \d+ (?:more|common frames omitted))/;
const MAX_ENTRY = 64 * 1024;
/** Lines written this close together (by Docker's clock) can belong to one entry. */
const SAME_WRITE_MS = 1000;
/** Entries that usually have more lines coming: errors, `Traceback`, `panic:`, a line ending in `:` `{` `[` `(`. */
const OPENS_BLOCK = /\w*(?:Error|Exception)\b|^Traceback \(|^panic: |[:{[(]\s*$/;

/**
 * Folds stack traces and other indented continuation lines into the entry before them, so an error and its
 * `    at …` frames arrive as one log line. Blank lines are dropped. An entry is emitted when a non-continuation line
 * arrives, or after a quiet period: short for ordinary lines, long for ones that open a block. Docker's follower
 * sometimes delivers the last lines of a burst only when the container writes again (seconds later), so grouping
 * goes by Docker's timestamps, not arrival time.
 */
export class MultilineMerger {
  private pending: Entry | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly onEntry: (entry: Entry) => void,
    private readonly idleMs = { line: 500, block: 5000 },
  ) {}

  add(line: RawLine): void {
    if (!line.message.trim()) return;
    const p = this.pending;
    if (
      p &&
      p.stream === line.stream &&
      CONTINUATION.test(line.message) &&
      Date.parse(line.timestamp) - Date.parse(p.lastTimestamp) < SAME_WRITE_MS &&
      p.message.length + line.message.length < MAX_ENTRY
    ) {
      p.message += `\n${line.message}`;
      p.lastTimestamp = line.timestamp;
    } else {
      this.flush();
      this.pending = { ...line, lastTimestamp: line.timestamp };
    }
    if (this.timer) clearTimeout(this.timer);
    const pending = this.pending!;
    const opensBlock = pending.message.includes("\n") || OPENS_BLOCK.test(pending.message);
    this.timer = setTimeout(() => this.flush(), opensBlock ? this.idleMs.block : this.idleMs.line);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const p = this.pending;
    this.pending = null;
    if (p) this.onEntry(p);
  }
}

/**
 * Docker's `since` takes `<seconds>.<nanoseconds>` and includes lines at exactly that time, so resume 1ns after the
 * last line that was read.
 */
export function sinceAfter(timestamp: string): string {
  const frac = (/\.(\d+)/.exec(timestamp)?.[1] ?? "").padEnd(9, "0").slice(0, 9);
  let seconds = Math.floor(Date.parse(timestamp.replace(/\.\d+/, "")) / 1000);
  let nanos = Number(frac) + 1;
  if (nanos >= 1e9) {
    seconds += 1;
    nanos -= 1e9;
  }
  return `${seconds}.${String(nanos).padStart(9, "0")}`;
}

/** Compares two RFC 3339 timestamps with nanosecond precision. */
export function compareTimestamps(a: string, b: string): number {
  const [sa, na] = sinceAfter(a).split(".").map(Number);
  const [sb, nb] = sinceAfter(b).split(".").map(Number);
  return sa - sb || na - nb;
}

/** `*`-glob list (`api-*, worker`) to a matcher. */
export function globMatcher(list: string | undefined): ((name: string) => boolean) | null {
  const globs = (list ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!globs.length) return null;
  const res = globs.map((g) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`));
  return (name) => res.some((re) => re.test(name));
}

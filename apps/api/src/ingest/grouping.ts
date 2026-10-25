import { createHash } from "node:crypto";
import type { ExceptionValue, Frame, IncomingEvent } from "./schema";
import { framePath, isInAppPath } from "./symbolicate";

const GROUPING_FRAMES = 5;

/** Strips volatile parts of a message (ids, numbers, hex, quoted values) so variants group together. */
export function normalizeMessage(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
    .replace(/https?:\/\/[^\s'"]+/g, "<url>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .slice(0, 500);
}

/** Path for grouping: last 3 segments, build hashes removed, so redeploys don't split issues. */
export function normalizeFramePath(file: string | undefined): string {
  const p = framePath(file) ?? "";
  return p
    .split("/")
    .filter(Boolean)
    .slice(-3)
    .join("/")
    .replace(/[-.][0-9a-f]{8,}(?=[._-])/gi, "")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hash>");
}

function frameKey(f: Frame): string {
  const fn = (f.function ?? "").replace(/^(async |new )/, "");
  return `${normalizeFramePath(f.filename ?? f.abs_path)}:${fn}`;
}

function groupingFrames(exc: ExceptionValue): Frame[] {
  const frames = exc.stacktrace?.frames ?? [];
  const inApp = frames.filter((f) => f.in_app);
  return (inApp.length ? inApp : frames).slice(0, GROUPING_FRAMES);
}

/** Components that identify "the same problem": exception type + top in-app frames, or the normalized message. */
export function defaultGroupingComponents(event: IncomingEvent): string[] {
  const exc = event.exception?.values[0];
  if (exc) {
    const frames = groupingFrames(exc);
    if (frames.length) return [exc.type, ...frames.map(frameKey)];
    return [exc.type, normalizeMessage(exc.value)];
  }
  return ["message", normalizeMessage(event.message ?? "")];
}

export function fingerprint(event: IncomingEvent): string {
  const defaults = defaultGroupingComponents(event);
  const parts = event.fingerprint?.length
    ? event.fingerprint.flatMap((p) => (p === "{{ default }}" || p === "{{default}}" ? defaults : [p]))
    : defaults;
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);
}

export interface IssueSummary {
  title: string;
  culprit: string | null;
  type: string | null;
  value: string | null;
}

export function summarize(event: IncomingEvent): IssueSummary {
  const exc = event.exception?.values[0];
  if (exc) {
    const value = exc.value.split("\n")[0];
    return {
      title: (value ? `${exc.type}: ${value}` : exc.type).slice(0, 300),
      culprit: event.transaction ?? culpritFromFrames(exc.stacktrace?.frames ?? []),
      type: exc.type,
      value: exc.value.slice(0, 1000),
    };
  }
  const message = (event.message ?? "(no message)").split("\n")[0];
  return { title: message.slice(0, 300), culprit: event.transaction ?? null, type: null, value: null };
}

function culpritFromFrames(frames: Frame[]): string | null {
  const f = frames.find((x) => x.in_app) ?? frames[0];
  if (!f) return null;
  const file = (framePath(f.filename ?? f.abs_path) ?? "").split("/").slice(-2).join("/");
  return f.function && f.function !== "<anonymous>" ? `${f.function} (${file})` : file || null;
}

/** Final in-app decision after symbolication: never in-app inside node_modules / framework runtime. */
export function finalizeInApp(frames: Frame[]): void {
  for (const f of frames) {
    const path = f.filename ?? f.abs_path ?? "";
    if (!isInAppPath(path)) f.in_app = false;
    else if (f.in_app === undefined) f.in_app = true;
  }
}

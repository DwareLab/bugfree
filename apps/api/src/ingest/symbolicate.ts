import { FlattenMap, type TraceMap, originalPositionFor, sourceContentFor } from "@jridgewell/trace-mapping";
import { one, query } from "../db";
import type { Frame } from "./schema";

export interface MappedFrame extends Frame {
  mapped?: boolean;
  raw_filename?: string;
  raw_function?: string;
  raw_lineno?: number;
  raw_colno?: number;
}

/** Looks up artifact ids by name and loads parsed source maps. Swappable in tests. */
export interface ArtifactStore {
  /** Artifact names for a release, e.g. "~/_next/static/chunks/main-abc.js.map" → id. */
  list(projectId: number, release: string): Promise<Map<string, number>>;
  load(artifactId: number): Promise<string | null>;
}

export const dbArtifactStore: ArtifactStore = {
  async list(projectId, release) {
    const rows = await query<{ id: number; name: string }>(
      `SELECT a.id, a.name FROM artifacts a JOIN releases r ON r.id = a.release_id WHERE r.project_id = $1 AND r.version = $2`,
      [projectId, release],
    );
    return new Map(rows.map((r) => [r.name, r.id]));
  },
  async load(artifactId) {
    const row = await one<{ content: Buffer }>(`SELECT content FROM artifacts WHERE id = $1`, [artifactId]);
    return row ? row.content.toString("utf8") : null;
  },
};

const CONTEXT_LINES = 5;
const INDEX_TTL_MS = 30_000;
const MAX_CACHED_MAPS = 30;

interface ReleaseIndex {
  at: number;
  /** [path the artifact applies to ("/_next/static/chunks/main-abc.js"), artifact id], longest first. */
  entries: Array<[string, number]>;
}

export class Symbolicator {
  private indexes = new Map<string, ReleaseIndex>();
  private maps = new Map<number, TraceMap | null>();

  constructor(private store: ArtifactStore = dbArtifactStore) {}

  /** Invalidate cached artifact lists after an upload. */
  forget(projectId: number, release: string): void {
    this.indexes.delete(`${projectId}:${release}`);
  }

  /** Maps minified frames (innermost first) back to original sources. Frames without a map are left untouched. */
  async symbolicate(projectId: number, release: string | undefined, frames: Frame[]): Promise<MappedFrame[]> {
    if (!release || !frames.length) return frames;
    const index = await this.index(projectId, release);
    if (!index.entries.length) return frames;

    const results: Array<{ frame: MappedFrame; callName: string | null }> = [];
    for (const frame of frames) {
      results.push(await this.mapFrame(index, frame));
    }
    // Fallback when the original source gave no enclosing function: a frame's position is a call site,
    // and the mapped token there names the function called by the frame before it.
    return results.map(({ frame }, i) => {
      const callerName = results[i + 1]?.callName;
      if (frame.mapped && callerName && looksMinified(frame.function)) frame.function = callerName;
      return frame;
    });
  }

  private async mapFrame(index: ReleaseIndex, frame: Frame): Promise<{ frame: MappedFrame; callName: string | null }> {
    const file = framePath(frame.abs_path ?? frame.filename);
    if (!file || !frame.lineno) return { frame, callName: null };
    const artifactId = index.entries.find(([p]) => file === p || file.endsWith(p))?.[1];
    if (artifactId === undefined) return { frame, callName: null };
    const map = await this.map(artifactId);
    if (!map) return { frame, callName: null };

    const pos = originalPositionFor(map, { line: frame.lineno, column: Math.max(0, (frame.colno ?? 1) - 1) });
    if (pos.source == null || pos.line == null) return { frame, callName: null };

    const mapped: MappedFrame = {
      ...frame,
      filename: cleanSourcePath(pos.source),
      lineno: pos.line,
      colno: (pos.column ?? 0) + 1,
      mapped: true,
      raw_filename: frame.filename,
      raw_function: frame.function,
      raw_lineno: frame.lineno,
      raw_colno: frame.colno,
      pre_context: undefined,
      context_line: undefined,
      post_context: undefined,
    };
    const content = sourceContentFor(map, pos.source);
    if (content) {
      const lines = content.split(/\r?\n/);
      const idx = pos.line - 1;
      if (looksMinified(mapped.function)) {
        const enclosing = enclosingFunctionName(lines, idx);
        if (enclosing) mapped.function = enclosing;
      }
      if (idx >= 0 && idx < lines.length) {
        const clip = (l: string) => (l.length > 300 ? `${l.slice(0, 300)}…` : l);
        mapped.pre_context = lines.slice(Math.max(0, idx - CONTEXT_LINES), idx).map(clip);
        mapped.context_line = clip(lines[idx]);
        mapped.post_context = lines.slice(idx + 1, idx + 1 + CONTEXT_LINES).map(clip);
      }
    }
    mapped.in_app = isInAppPath(mapped.filename!);
    return { frame: mapped, callName: pos.name ?? null };
  }

  private async index(projectId: number, release: string): Promise<ReleaseIndex> {
    const key = `${projectId}:${release}`;
    const cached = this.indexes.get(key);
    if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached;
    const names = await this.store.list(projectId, release);
    const entries: Array<[string, number]> = [];
    for (const [name, id] of names) {
      if (!name.endsWith(".map")) continue;
      // "~/_next/static/x.js.map" applies to any path ending in "/_next/static/x.js".
      const applies = name.replace(/^~/, "").replace(/\.map$/, "");
      entries.push([applies.startsWith("/") ? applies : `/${applies}`, id]);
    }
    entries.sort((a, b) => b[0].length - a[0].length);
    const index = { at: Date.now(), entries };
    this.indexes.set(key, index);
    return index;
  }

  private async map(artifactId: number): Promise<TraceMap | null> {
    if (this.maps.has(artifactId)) {
      const hit = this.maps.get(artifactId)!;
      this.maps.delete(artifactId);
      this.maps.set(artifactId, hit);
      return hit;
    }
    let map: TraceMap | null = null;
    try {
      const content = await this.store.load(artifactId);
      // FlattenMap also handles index maps with "sections" (emitted by Turbopack).
      if (content) map = FlattenMap(content);
    } catch {
      map = null;
    }
    this.maps.set(artifactId, map);
    if (this.maps.size > MAX_CACHED_MAPS) this.maps.delete(this.maps.keys().next().value!);
    return map;
  }
}

/** URL → pathname; file path → posix path. Drops query strings and hashes. */
export function framePath(file: string | undefined): string | null {
  if (!file) return null;
  if (/^(https?|file):\/\//.test(file)) {
    try {
      return decodeURIComponent(new URL(file).pathname);
    } catch {
      return null;
    }
  }
  return file.replace(/\\/g, "/").replace(/[?#].*$/, "");
}

/** "webpack://_N_E/./app/page.tsx?abc" → "app/page.tsx"; "turbopack:///[project]/app/page.tsx" → "app/page.tsx". */
export function cleanSourcePath(source: string): string {
  return source
    .replace(/^webpack:\/\/[^/]*\//, "")
    .replace(/^turbopack:\/\/\/?(\[project\]\/)?/, "")
    .replace(/^file:\/\//, "")
    .replace(/[?#].*$/, "")
    .replace(/^(\.\.?\/)+/, "");
}

/** Minifier output ("t", "eN", "<anonymous>") rather than a real function name. */
export function looksMinified(name: string | undefined): boolean {
  return !name || name === "<anonymous>" || name === "?" || /^[A-Za-z_$][\w$]?$/.test(name);
}

const DECLARATION =
  /(?:function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(])|(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)[^=]*=>|[A-Za-z_$][\w$]*\s*=>))|^\s*(?:(?:public|private|protected|static|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{/;
const NOT_A_NAME = new Set(["if", "for", "while", "switch", "catch", "with", "return", "function"]);

/** Name of the function whose body contains `lineIdx`, found by scanning upward and tracking brace depth. */
export function enclosingFunctionName(lines: string[], lineIdx: number): string | null {
  let depth = 0;
  for (let i = lineIdx - 1; i >= 0 && i >= lineIdx - 200; i--) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === "}") depth++;
      else if (ch === "{") depth--;
    }
    if (depth >= 0) continue;
    const m = DECLARATION.exec(line);
    const name = m && (m[1] ?? m[2] ?? m[3]);
    if (name && !NOT_A_NAME.has(name)) return name;
  }
  return null;
}

const NOT_IN_APP = /(^|\/)node_modules\/|^node:|\(webpack\)|webpack\/(runtime|bootstrap)|^next\/dist\/|\[turbopack\]|\[externals\]/;

export function isInAppPath(path: string): boolean {
  return !NOT_IN_APP.test(path);
}

import { promises as fs } from "node:fs";
import type { StackFrame } from "@dwarelab/bugfree-core";

const CONTEXT_LINES = 5;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CACHED_FILES = 100;
const MAX_LINE_LENGTH = 300;

// Source file lines by path; null means the file could not be read.
const cache = new Map<string, string[] | null>();

async function readLines(path: string): Promise<string[] | null> {
  if (cache.has(path)) {
    const hit = cache.get(path)!;
    cache.delete(path);
    cache.set(path, hit);
    return hit;
  }
  let lines: string[] | null = null;
  try {
    const stat = await fs.stat(path);
    if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
      lines = (await fs.readFile(path, "utf8")).split(/\r?\n/);
    }
  } catch {
    lines = null;
  }
  cache.set(path, lines);
  if (cache.size > MAX_CACHED_FILES) cache.delete(cache.keys().next().value!);
  return lines;
}

const clip = (line: string) => (line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line);

/** Adds the surrounding source lines to in-app frames that point at readable files. */
export async function addContextLines(frames: StackFrame[]): Promise<void> {
  await Promise.all(
    frames.map(async (frame) => {
      if (!frame.in_app || !frame.abs_path || !frame.lineno || frame.context_line !== undefined) return;
      const lines = await readLines(frame.abs_path);
      if (!lines) return;
      const idx = frame.lineno - 1;
      if (idx < 0 || idx >= lines.length) return;
      // Minified bundles: one huge line is useless as context.
      if (lines[idx].length > 2000) return;
      frame.pre_context = lines.slice(Math.max(0, idx - CONTEXT_LINES), idx).map(clip);
      frame.context_line = clip(lines[idx]);
      frame.post_context = lines.slice(idx + 1, idx + 1 + CONTEXT_LINES).map(clip);
    }),
  );
}

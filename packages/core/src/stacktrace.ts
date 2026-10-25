import type { StackFrame } from "./types";

const MAX_FRAMES = 50;

// V8 (Node, Chrome, Edge):  "    at fn (file:line:col)" / "    at file:line:col" / "    at async fn (file:line:col)"
const V8_WITH_FN = /^\s*at (?:async )?(.+?) \((.+?):(\d+):(\d+)\)\s*$/;
const V8_NO_FN = /^\s*at (?:async )?(.+?):(\d+):(\d+)\s*$/;
// V8 frames without position: "    at fn (native)" / "    at new Promise (<anonymous>)"
const V8_NO_POS = /^\s*at (?:async )?(.+?) \((native|<anonymous>|index \d+)\)\s*$/;
// Gecko / WebKit: "fn@file:line:col" / "@file:line:col"
const GECKO = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/;

/** Parses an `Error.stack` string. Returns frames innermost (throwing) first. */
export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const line of stack.split("\n")) {
    if (frames.length >= MAX_FRAMES) break;
    const frame = parseLine(line);
    if (frame) frames.push(frame);
  }
  return frames;
}

function parseLine(line: string): StackFrame | null {
  let m = V8_WITH_FN.exec(line);
  if (m) {
    // "at eval (eval at fn (file:1:2), <anonymous>:1:1)" — keep the outer location.
    const location = m[2].startsWith("eval at ") ? undefined : m[2];
    if (!location) return { function: cleanFn(m[1]), filename: "<eval>", abs_path: "<eval>" };
    return frame(cleanFn(m[1]), location, m[3], m[4]);
  }
  m = V8_NO_FN.exec(line);
  if (m) return frame(undefined, m[1], m[2], m[3]);
  m = V8_NO_POS.exec(line);
  if (m) return { function: cleanFn(m[1]), filename: m[2], abs_path: m[2] };
  if (/^\s*at /.test(line)) return null;
  m = GECKO.exec(line);
  if (m) return frame(cleanFn(m[1]) || undefined, m[2], m[3], m[4]);
  return null;
}

function frame(fn: string | undefined, file: string, line: string, col: string): StackFrame {
  return {
    function: fn || "<anonymous>",
    filename: file,
    abs_path: file,
    lineno: Number(line),
    colno: Number(col),
  };
}

function cleanFn(fn: string): string {
  return fn
    .replace(/ \[as [^\]]+\]$/, "")
    .replace(/^Object\.<anonymous>$/, "<anonymous>")
    .trim();
}

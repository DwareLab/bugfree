import { parseStack } from "./stacktrace";
import type { ExceptionValue, Mechanism } from "./types";
import { isError, normalize, truncate } from "./utils";

const MAX_CAUSES = 5;

/** Converts anything that was thrown into exception values: the error first, then its `cause` chain. */
export function exceptionFromThrown(thrown: unknown, mechanism?: Mechanism): ExceptionValue[] {
  const values: ExceptionValue[] = [];
  let current: unknown = thrown;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && values.length <= MAX_CAUSES && !seen.has(current)) {
    seen.add(current);
    values.push(singleException(current));
    current = isError(current) ? (current as Error & { cause?: unknown }).cause : undefined;
  }
  if (values.length && mechanism) values[0].mechanism = mechanism;
  return values;
}

function singleException(thrown: unknown): ExceptionValue {
  if (isError(thrown)) {
    const err = thrown as Error;
    const type = err.name && err.name !== "Error" ? err.name : err.constructor?.name && err.constructor.name !== "Object" ? err.constructor.name : "Error";
    return {
      type,
      value: truncate(String(err.message ?? ""), 8000),
      stacktrace: { frames: parseStack(err.stack) },
    };
  }
  if (typeof thrown === "string") return { type: "Error", value: truncate(thrown, 8000) };
  if (typeof thrown === "object" && thrown !== null) {
    // Event-like objects (e.g. DOM Event from a failed <script>) and plain objects.
    const ctor = (thrown as object).constructor?.name;
    const keys = Object.keys(thrown).slice(0, 10).join(", ");
    return {
      type: ctor && ctor !== "Object" ? ctor : "Error",
      value: `Non-Error thrown${keys ? ` with keys: ${keys}` : ""}: ${truncate(JSON.stringify(normalize(thrown, 3)), 500)}`,
    };
  }
  return { type: "Error", value: `Non-Error thrown: ${String(thrown)}` };
}

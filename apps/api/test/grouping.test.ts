import { describe, expect, it } from "vitest";
import { fingerprint, normalizeFramePath, normalizeMessage, summarize } from "../src/ingest/grouping";
import { eventSchema, type IncomingEvent } from "../src/ingest/schema";

function event(partial: Partial<IncomingEvent>): IncomingEvent {
  return eventSchema.parse({ event_id: "a".repeat(32), platform: "node", level: "error", ...partial });
}

const frames = (line: number) => [
  { function: "lineTotal", filename: "lib/cart.ts", lineno: line, colno: 5, in_app: true },
  { function: "cartTotal", filename: "lib/cart.ts", lineno: line - 5, colno: 3, in_app: true },
  { function: "Layer.handle", filename: "/srv/node_modules/router/layer.js", lineno: 95, colno: 5, in_app: false },
];

describe("fingerprint", () => {
  it("groups the same error from different lines and messages together", () => {
    const a = event({ exception: { values: [{ type: "RangeError", value: "Invalid quantity -1 for SOCKS", stacktrace: { frames: frames(13) } }] } });
    const b = event({ exception: { values: [{ type: "RangeError", value: "Invalid quantity 0 for MUG", stacktrace: { frames: frames(15) } }] } });
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("separates different exception types and call paths", () => {
    const a = event({ exception: { values: [{ type: "RangeError", value: "x", stacktrace: { frames: frames(13) } }] } });
    const b = event({ exception: { values: [{ type: "TypeError", value: "x", stacktrace: { frames: frames(13) } }] } });
    const c = event({
      exception: { values: [{ type: "RangeError", value: "x", stacktrace: { frames: [{ function: "other", filename: "lib/other.ts", lineno: 1, in_app: true }] } }] },
    });
    expect(new Set([fingerprint(a), fingerprint(b), fingerprint(c)]).size).toBe(3);
  });

  it("is stable across redeploys that change chunk hashes", () => {
    const at = (file: string) =>
      event({ exception: { values: [{ type: "Error", value: "x", stacktrace: { frames: [{ function: "t", filename: file, lineno: 1, colno: 9, in_app: true }] } }] } });
    expect(fingerprint(at("https://a.test/_next/static/chunks/page-3f9a8b7c6d5e.js"))).toBe(fingerprint(at("https://a.test/_next/static/chunks/page-0011aabbccdd.js")));
  });

  it("groups messages without stack traces by normalized text", () => {
    expect(fingerprint(event({ message: "Order 1234 failed after 3 retries" }))).toBe(fingerprint(event({ message: "Order 98 failed after 5 retries" })));
  });

  it("supports custom fingerprints and {{ default }}", () => {
    const base = { exception: { values: [{ type: "Error", value: "x", stacktrace: { frames: frames(13) } }] } };
    expect(fingerprint(event({ ...base, fingerprint: ["payments"] }))).toBe(fingerprint(event({ message: "y", fingerprint: ["payments"] })));
    expect(fingerprint(event({ ...base, fingerprint: ["{{ default }}", "eu"] }))).not.toBe(fingerprint(event(base)));
  });
});

describe("normalization helpers", () => {
  it("strips volatile values from messages", () => {
    expect(normalizeMessage("User 550e8400-e29b-41d4-a716-446655440000 hit https://x.test/a?b=1 at 0xdeadbeef")).toBe("User <uuid> hit <url> at <hex>");
  });
  it("keeps the last path segments and drops hashes", () => {
    expect(normalizeFramePath("https://a.test/_next/static/chunks/app/page-3f9a8b7c6d5e.js")).toBe("chunks/app/page.js");
    expect(normalizeFramePath("/home/ci/build/src/routes/users.ts")).toBe("src/routes/users.ts");
  });
});

describe("summarize", () => {
  it("builds title and culprit", () => {
    const s = summarize(event({ transaction: "GET /users/:id", exception: { values: [{ type: "TypeError", value: "boom\nmore", stacktrace: { frames: frames(10) } }] } }));
    expect(s).toMatchObject({ title: "TypeError: boom", culprit: "GET /users/:id", type: "TypeError" });
    const noTxn = summarize(event({ exception: { values: [{ type: "TypeError", value: "boom", stacktrace: { frames: frames(10) } }] } }));
    expect(noTxn.culprit).toBe("lineTotal (lib/cart.ts)");
  });
});

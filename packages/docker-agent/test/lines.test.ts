import { describe, expect, it } from "vitest";
import { compareTimestamps, type Entry, globMatcher, LogStreamParser, MultilineMerger, type RawLine, sinceAfter } from "../src/lines";

function frame(type: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function parse(tty: boolean, chunks: Buffer[]): RawLine[] {
  const lines: RawLine[] = [];
  const p = new LogStreamParser(tty, (l) => lines.push(l));
  for (const c of chunks) p.push(c);
  p.end();
  return lines;
}

describe("LogStreamParser", () => {
  it("demultiplexes stdout and stderr frames and splits timestamps", () => {
    const lines = parse(false, [frame(1, "2026-10-25T11:00:00.000000001Z listening on :3000\n"), frame(2, "2026-10-25T11:00:01.5Z Error: boom\n")]);
    expect(lines).toEqual([
      { stream: "stdout", timestamp: "2026-10-25T11:00:00.000000001Z", message: "listening on :3000" },
      { stream: "stderr", timestamp: "2026-10-25T11:00:01.5Z", message: "Error: boom" },
    ]);
  });

  it("handles frames and UTF-8 characters split across chunks", () => {
    const all = Buffer.concat([frame(1, "2026-10-25T11:00:00Z héllo wörld\n"), frame(1, "2026-10-25T11:00:01Z second\n")]);
    const chunks = [all.subarray(0, 5), all.subarray(5, 33), all.subarray(33)];
    expect(parse(false, chunks).map((l) => l.message)).toEqual(["héllo wörld", "second"]);
  });

  it("reads raw TTY output and strips carriage returns", () => {
    const lines = parse(true, [Buffer.from("2026-10-25T11:00:00Z one\r\n2026-10-25T11:00:00Z tw"), Buffer.from("o\r\n")]);
    expect(lines.map((l) => [l.stream, l.message])).toEqual([
      ["stdout", "one"],
      ["stdout", "two"],
    ]);
  });
});

describe("MultilineMerger", () => {
  it("folds stack frames into the error line and drops blank lines", () => {
    const out: Entry[] = [];
    const m = new MultilineMerger((e) => out.push(e));
    const at = (message: string, timestamp = "2026-10-25T11:00:00Z"): RawLine => ({ stream: "stderr", timestamp, message });
    m.add(at("Error: boom", "2026-10-25T11:00:00.1Z"));
    m.add(at("    at handler (/app/server.js:10:11)", "2026-10-25T11:00:00.2Z"));
    m.add(at("    at Layer.handle (/app/node_modules/router/layer.js:95:5)", "2026-10-25T11:00:00.3Z"));
    m.add(at(""));
    m.add(at("Node.js v24.0.0", "2026-10-25T11:00:00.4Z"));
    m.flush();
    expect(out.map((e) => e.message)).toEqual([
      "Error: boom\n    at handler (/app/server.js:10:11)\n    at Layer.handle (/app/node_modules/router/layer.js:95:5)",
      "Node.js v24.0.0",
    ]);
    expect(out[0].timestamp).toBe("2026-10-25T11:00:00.1Z");
    expect(out[0].lastTimestamp).toBe("2026-10-25T11:00:00.3Z");
  });

  it("does not merge indented lines written much later", () => {
    const out: Entry[] = [];
    const m = new MultilineMerger((e) => out.push(e));
    m.add({ stream: "stdout", timestamp: "2026-10-25T11:00:00Z", message: "Config:" });
    m.add({ stream: "stdout", timestamp: "2026-10-25T11:00:05Z", message: "  unrelated indented output" });
    m.flush();
    expect(out).toHaveLength(2);
  });

  it("does not merge across streams", () => {
    const out: Entry[] = [];
    const m = new MultilineMerger((e) => out.push(e));
    m.add({ stream: "stdout", timestamp: "2026-10-25T11:00:00Z", message: "a" });
    m.add({ stream: "stderr", timestamp: "2026-10-25T11:00:00Z", message: "  b" });
    m.flush();
    expect(out).toHaveLength(2);
  });
});

describe("cursors", () => {
  it("resumes one nanosecond after the last line", () => {
    expect(sinceAfter("2026-10-25T11:00:00.123456789Z")).toBe("1792926000.123456790");
    expect(sinceAfter("2026-10-25T11:00:00Z")).toBe("1792926000.000000001");
    expect(sinceAfter("2026-10-25T11:00:00.999999999Z")).toBe("1792926001.000000000");
  });

  it("orders timestamps with nanosecond precision", () => {
    expect(compareTimestamps("2026-10-25T11:00:00.000000002Z", "2026-10-25T11:00:00.000000001Z")).toBeGreaterThan(0);
    expect(compareTimestamps("2026-10-25T11:00:00Z", "2026-10-25T11:00:00.000000000Z")).toBe(0);
    expect(compareTimestamps("2026-10-25T10:59:59.9Z", "2026-10-25T11:00:00Z")).toBeLessThan(0);
  });
});

describe("globMatcher", () => {
  it("matches comma-separated globs", () => {
    const m = globMatcher("shop-*, worker")!;
    expect(m("shop-api-1")).toBe(true);
    expect(m("worker")).toBe(true);
    expect(m("worker-2")).toBe(false);
    expect(globMatcher("")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { detectLevel, normalizeLog, stripAnsi } from "../src/logs/normalize";

const now = new Date("2026-10-25T12:00:00.000Z");
const norm = (message: string, extra: Record<string, unknown> = {}) => normalizeLog({ message, ...extra }, "web-1", now);

describe("detectLevel", () => {
  it.each([
    ["2026-10-25 11:22:33.123 UTC [1] LOG:  database system is ready", "info"],
    ["2026/10/25 11:22:33 [error] 29#29: *1 connect() failed", "error"],
    ['time=2026-10-25T11:22:33Z level=warn msg="slow query"', "warning"],
    ["[Nest] 1  - 10/25/2026, 11:22:33 AM   ERROR [ExceptionHandler] boom", "error"],
    ["TypeError: Cannot read properties of undefined (reading 'id')", "error"],
    ["Error: connect ECONNREFUSED 127.0.0.1:5432", "error"],
    ["Traceback (most recent call last):", "error"],
    ["WARNING: no config file found", "warning"],
    ["debug: cache miss for key user:42", "debug"],
  ])("%s → %s", (line, level) => {
    expect(detectLevel(line)).toBe(level);
  });

  it("ignores lower-case level words inside sentences", () => {
    expect(detectLevel("Listening on :3000, no error so far")).toBeUndefined();
    expect(detectLevel("GET /api/login 200 12ms")).toBeUndefined();
  });
});

describe("normalizeLog", () => {
  it("parses pino JSON lines", () => {
    const l = norm(JSON.stringify({ level: 50, time: 1761390000000, pid: 1, hostname: "x", reqId: "r1", msg: "payment failed" }));
    expect(l.level).toBe("error");
    expect(l.message).toBe("payment failed");
    expect(l.attributes).toEqual({ pid: 1, hostname: "x", reqId: "r1" });
  });

  it("parses winston / logrus style JSON with string levels", () => {
    const l = norm(JSON.stringify({ level: "warning", message: "disk almost full", percent: 91 }));
    expect(l.level).toBe("warning");
    expect(l.message).toBe("disk almost full");
    expect(l.attributes).toEqual({ percent: 91 });
  });

  it("keeps JSON without a message field as the raw line", () => {
    const raw = JSON.stringify({ event: "signup", userId: 7 });
    const l = norm(raw);
    expect(l.message).toBe(raw);
    expect(l.attributes).toEqual({ event: "signup", userId: 7 });
    expect(l.level).toBe("info");
  });

  it("prefers an explicit level from the collector", () => {
    expect(norm("ERROR something", { level: "debug" }).level).toBe("debug");
  });

  it("strips ANSI colors and trailing carriage returns", () => {
    expect(stripAnsi("\x1b[31merror\x1b[39m done")).toBe("error done");
    expect(norm("\x1b[32mINFO\x1b[0m ready\r").message).toBe("INFO ready");
  });

  it("keeps the collector's timestamp precision and falls back to now", () => {
    expect(norm("x", { timestamp: "2026-10-25T11:22:33.123456789Z" }).ts).toBe("2026-10-25T11:22:33.123456789Z");
    expect(norm("x", { timestamp: 1761391353 }).ts).toBe("2025-10-25T11:22:33.000Z");
    expect(norm("x", { timestamp: "garbage" }).ts).toBe(now.toISOString());
  });

  it("fills container metadata", () => {
    const l = norm("x", { container: "/shop-api-1", container_id: "0123456789abcdef0123", stream: "stderr" });
    expect(l).toMatchObject({ container: "shop-api-1", container_id: "0123456789ab", stream: "stderr", host: "web-1" });
  });

  it("truncates huge lines", () => {
    const l = norm("a".repeat(20_000));
    expect(l.message.length).toBeLessThan(16_500);
    expect(l.message).toMatch(/truncated 3616 chars/);
  });
});

import { describe, expect, it } from "vitest";
import { parseDsn, ingestUrl } from "../src/dsn";
import { exceptionFromThrown } from "../src/exception";
import { parseStack } from "../src/stacktrace";
import { normalize, scrubHeaders, scrubUrl } from "../src/utils";

describe("parseStack", () => {
  it("parses V8 stacks (Node / Chrome), innermost frame first", () => {
    const stack = `TypeError: Cannot read properties of undefined (reading 'profile')
    at findUser (/srv/app/src/users.js:7:10)
    at async Object.handler [as get] (/srv/app/src/server.js:34:3)
    at new Promise (<anonymous>)
    at https://shop.example.com/_next/static/chunks/main-abc.js:1:2345
    at Layer.handle (node:internal/router:12:5)`;
    expect(parseStack(stack)).toEqual([
      { function: "findUser", filename: "/srv/app/src/users.js", abs_path: "/srv/app/src/users.js", lineno: 7, colno: 10 },
      { function: "Object.handler", filename: "/srv/app/src/server.js", abs_path: "/srv/app/src/server.js", lineno: 34, colno: 3 },
      { function: "new Promise", filename: "<anonymous>", abs_path: "<anonymous>" },
      {
        function: "<anonymous>",
        filename: "https://shop.example.com/_next/static/chunks/main-abc.js",
        abs_path: "https://shop.example.com/_next/static/chunks/main-abc.js",
        lineno: 1,
        colno: 2345,
      },
      { function: "Layer.handle", filename: "node:internal/router", abs_path: "node:internal/router", lineno: 12, colno: 5 },
    ]);
  });

  it("parses Firefox / Safari stacks", () => {
    const frames = parseStack(`onClick@https://app.test/_next/static/chunks/page-1.js:1:900
@https://app.test/_next/static/chunks/main.js:2:10`);
    expect(frames.map((f) => [f.function, f.lineno, f.colno])).toEqual([
      ["onClick", 1, 900],
      ["<anonymous>", 2, 10],
    ]);
  });

  it("ignores junk lines and handles undefined", () => {
    expect(parseStack(undefined)).toEqual([]);
    expect(parseStack("Error: boom\n    at <anonymous>")).toEqual([]);
  });
});

describe("exceptionFromThrown", () => {
  it("follows the cause chain", () => {
    const err = new Error("Could not load orders", { cause: new TypeError("socket hang up") });
    const values = exceptionFromThrown(err, { type: "express", handled: false });
    expect(values.map((v) => `${v.type}: ${v.value}`)).toEqual(["Error: Could not load orders", "TypeError: socket hang up"]);
    expect(values[0].mechanism).toEqual({ type: "express", handled: false });
  });

  it("describes non-Error throwables", () => {
    expect(exceptionFromThrown("plain string")[0]).toEqual({ type: "Error", value: "plain string" });
    expect(exceptionFromThrown({ code: 42 })[0].value).toContain("Non-Error thrown with keys: code");
  });

  it("uses custom error class names", () => {
    class PaymentError extends Error {}
    expect(exceptionFromThrown(new PaymentError("declined"))[0].type).toBe("PaymentError");
  });
});

describe("dsn", () => {
  it("parses key, project and API base (with path prefix)", () => {
    expect(parseDsn("https://abc123@api.example.com/7")).toEqual({ publicKey: "abc123", projectId: "7", apiUrl: "https://api.example.com" });
    const dsn = parseDsn("http://k@localhost:4100/tracker/12");
    expect(ingestUrl(dsn)).toBe("http://localhost:4100/tracker/api/ingest/12?key=k");
  });

  it("rejects invalid DSNs", () => {
    expect(() => parseDsn("not a url")).toThrow(/Invalid DSN/);
    expect(() => parseDsn("https://api.example.com/7")).toThrow(/missing key/);
  });
});

describe("scrubbing", () => {
  it("filters credentials from headers, URLs and data", () => {
    expect(scrubHeaders({ Cookie: "a=b", Authorization: "Bearer x", "User-Agent": "curl" })).toEqual({
      cookie: "[Filtered]",
      authorization: "[Filtered]",
      "user-agent": "curl",
    });
    expect(scrubUrl("https://x.test/cb?code=1&access_token=secret&page=2")).toBe("https://x.test/cb?code=1&access_token=[Filtered]&page=2");
    expect(normalize({ user: "ada", password: "hunter2", nested: { apiKey: "k" } })).toEqual({ user: "ada", password: "[Filtered]", nested: { apiKey: "[Filtered]" } });
  });

  it("survives circular references", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(normalize(a)).toEqual({ name: "a", self: "[Circular]" });
  });
});

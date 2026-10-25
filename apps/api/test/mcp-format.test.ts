import { describe, expect, it } from "vitest";
import { formatEvent, formatException } from "../src/mcp/format";

const exception = {
  type: "RangeError",
  value: "Invalid quantity -1",
  mechanism: { type: "express", handled: false },
  stacktrace: {
    frames: [
      {
        function: "lineTotal",
        filename: "lib/cart.ts",
        lineno: 13,
        colno: 5,
        in_app: true,
        pre_context: ["function lineTotal(item) {"],
        context_line: "  if (item.qty < 0) throw new RangeError(msg);",
        post_context: ["}"],
      },
      { function: "Layer.handle", filename: "node_modules/router/layer.js", lineno: 95, colno: 5, in_app: false, context_line: "fn(req, res)" },
    ],
  },
};

describe("formatException", () => {
  it("renders frames most recent first with source context for app frames only", () => {
    expect(formatException(exception)).toBe(
      [
        "RangeError: Invalid quantity -1  (express, unhandled)",
        "  at lineTotal (lib/cart.ts:13:5)",
        "         12 | function lineTotal(item) {",
        "    >    13 |   if (item.qty < 0) throw new RangeError(msg);",
        "         14 | }",
        "  at Layer.handle (node_modules/router/layer.js:95:5) [library]",
      ].join("\n"),
    );
  });

  it("caps very deep stacks", () => {
    const frames = Array.from({ length: 50 }, (_, i) => ({ function: `f${i}`, filename: "a.js", lineno: i + 1 }));
    const out = formatException({ type: "Error", value: "deep", stacktrace: { frames } });
    expect(out).toContain("at f39 (a.js:40)");
    expect(out).not.toContain("at f40 ");
    expect(out).toContain("… 10 more frames");
  });
});

describe("formatEvent", () => {
  it("includes the cause chain, request and the last breadcrumbs", () => {
    const breadcrumbs = Array.from({ length: 25 }, (_, i) => ({ timestamp: `t${i}`, category: "console", message: `log ${i}` }));
    const out = formatEvent({
      id: 7,
      event_id: "e".repeat(32),
      issue_id: 3,
      occurred_at: "2026-01-02T03:04:05.000Z",
      prev_id: 6,
      next_id: null,
      data: {
        event_id: "e".repeat(32),
        level: "error",
        release: "1.2.0",
        exception: { values: [exception, { type: "Error", value: "db down" }] },
        request: { method: "POST", url: "https://shop.test/cart", query_string: "a=1" },
        breadcrumbs,
      },
    });
    expect(out).toContain("occurred: 2026-01-02T03:04:05.000Z · level: error · release: 1.2.0");
    expect(out).toContain("older event: 6 · newer event: none");
    expect(out).toContain("Caused by: Error: db down");
    expect(out).toContain("POST https://shop.test/cart?a=1");
    expect(out).toContain("last 20 of 25");
    expect(out).toContain("- t24 [console] log 24");
    expect(out).not.toContain("log 4\n");
  });
});

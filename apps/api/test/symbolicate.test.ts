import { transform } from "esbuild";
import { describe, expect, it } from "vitest";
import { type ArtifactStore, Symbolicator, cleanSourcePath, enclosingFunctionName, framePath } from "../src/ingest/symbolicate";

const SOURCE = `export function cartTotal(items) {
  return items.reduce((sum, item) => sum + lineTotal(item), 0);
}

function lineTotal(item) {
  if (item.quantity <= 0) {
    throw new RangeError("Invalid quantity " + item.quantity);
  }
  return item.price * item.quantity;
}

cartTotal(window.items);
`;

/** Minifies SOURCE with a real source map and returns where the `throw` ended up. */
async function build() {
  const out = await transform(SOURCE, { minify: true, sourcemap: "external", sourcefile: "webpack://_N_E/./lib/cart.js", format: "esm" });
  const lines = out.code.split("\n");
  const lineIdx = lines.findIndex((l) => l.includes("throw"));
  const col = lines[lineIdx].indexOf("throw new");
  return { map: out.map, line: lineIdx + 1, col: col + 1 };
}

function store(map: string, name = "~/_next/static/chunks/page-abc.js.map"): ArtifactStore {
  return {
    list: async () => new Map([[name, 1]]),
    load: async () => map,
  };
}

describe("Symbolicator", () => {
  it("maps a minified browser frame to the original file, line, function and source context", async () => {
    const { map, line, col } = await build();
    const sym = new Symbolicator(store(map));
    const [frame] = await sym.symbolicate(1, "v1", [
      { filename: "https://shop.test/_next/static/chunks/page-abc.js?v=1", abs_path: "https://shop.test/_next/static/chunks/page-abc.js?v=1", function: "o", lineno: line, colno: col, in_app: true },
    ]);
    expect(frame).toMatchObject({ filename: "lib/cart.js", lineno: 7, function: "lineTotal", mapped: true, raw_function: "o", in_app: true });
    expect(frame.context_line).toContain('throw new RangeError("Invalid quantity "');
    expect(frame.pre_context).toHaveLength(5);
  });

  it("matches server chunks by path suffix and leaves unknown files alone", async () => {
    const { map, line, col } = await build();
    const sym = new Symbolicator(store(map, "~/.next/server/chunks/ssr/page-abc.js.map"));
    const frames = await sym.symbolicate(1, "v1", [
      { filename: ".next/server/chunks/ssr/page-abc.js", abs_path: "/app/.next/server/chunks/ssr/page-abc.js", function: "o", lineno: line, colno: col, in_app: true },
      { filename: "node:internal/process", abs_path: "node:internal/process", function: "run", lineno: 3, colno: 1, in_app: false },
    ]);
    expect(frames[0]).toMatchObject({ filename: "lib/cart.js", lineno: 7, mapped: true });
    expect(frames[1]).toEqual({ filename: "node:internal/process", abs_path: "node:internal/process", function: "run", lineno: 3, colno: 1, in_app: false });
  });

  it("does nothing without a release", async () => {
    const sym = new Symbolicator(store("{}"));
    const input = [{ filename: "a.js", lineno: 1, colno: 1 }];
    expect(await sym.symbolicate(1, undefined, input)).toBe(input);
  });
});

describe("path helpers", () => {
  it("cleans bundler source paths", () => {
    expect(cleanSourcePath("webpack://_N_E/./app/page.tsx?1234")).toBe("app/page.tsx");
    expect(cleanSourcePath("turbopack:///[project]/app/page.tsx")).toBe("app/page.tsx");
    expect(cleanSourcePath("../../../../examples/demo/lib/cart.ts")).toBe("examples/demo/lib/cart.ts");
  });
  it("extracts paths from URLs and file paths", () => {
    expect(framePath("https://a.test/_next/static/x.js?v=2#h")).toBe("/_next/static/x.js");
    expect(framePath("C:\\app\\dist\\index.js")).toBe("C:/app/dist/index.js");
  });
  it("finds the enclosing function by brace depth", () => {
    const lines = SOURCE.split("\n");
    expect(enclosingFunctionName(lines, 6)).toBe("lineTotal");
    expect(enclosingFunctionName(lines, 1)).toBe("cartTotal");
    expect(enclosingFunctionName(lines, 11)).toBeNull();
  });
});

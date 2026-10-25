import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

// Workers have no filesystem, so worker-migrations.ts imports each migration explicitly.
test("the Workers build bundles every migration", () => {
  const root = path.resolve(__dirname, "..");
  const files = readdirSync(path.join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  const source = readFileSync(path.join(root, "src/worker-migrations.ts"), "utf8");
  const listed = [...source.matchAll(/name: "([^"]+\.sql)"/g)].map((m) => m[1]);
  expect(listed).toEqual(files);
  for (const file of files) expect(source).toContain(`"../migrations/${file}"`);
});

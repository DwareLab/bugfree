#!/usr/bin/env node
// Sets one version on every published package and on their references to each other.
// Usage: node scripts/set-version.mjs 0.2.0
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? "")) {
  console.error("Usage: node scripts/set-version.mjs <semver>");
  process.exit(1);
}
const packages = ["core", "browser", "node", "express", "nextjs", "cli"];
const names = new Set(packages.map((p) => `@dwarelab/bugfree-${p}`));
const files = [...packages.map((p) => `packages/${p}/package.json`), "examples/express-demo/package.json", "examples/next-demo/package.json"];

for (const file of files) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  if (file.startsWith("packages/")) pkg.version = version;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const dep of Object.keys(pkg[field] ?? {})) if (names.has(dep)) pkg[field][dep] = version;
  }
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}
const core = "packages/core/src/client.ts";
writeFileSync(core, readFileSync(core, "utf8").replace(/export const SDK_VERSION = "[^"]+";/, `export const SDK_VERSION = "${version}";`));
console.log(`Set ${packages.length} packages to ${version}. Run npm install to update the lockfile.`);

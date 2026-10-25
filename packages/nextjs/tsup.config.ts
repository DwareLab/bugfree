import { defineConfig } from "tsup";

const shared = {
  format: ["esm", "cjs"] as ["esm", "cjs"],
  dts: true,
  target: "es2020",
  external: ["react", "next", "@dwarelab/bugfree-core", "@dwarelab/bugfree-browser", "@dwarelab/bugfree-node"],
};

export default defineConfig([
  // Edge-safe: only depends on @dwarelab/bugfree-core, so instrumentation.ts can import it in every runtime.
  { ...shared, entry: { index: "src/index.ts" }, clean: true },
  { ...shared, entry: { server: "src/server.ts" }, platform: "node" },
  { ...shared, entry: { config: "src/config.ts" }, platform: "node" },
  { ...shared, entry: { client: "src/client.tsx" }, platform: "browser", banner: { js: '"use client";' } },
]);

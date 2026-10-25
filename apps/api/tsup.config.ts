import { defineConfig } from "tsup";

// Bundles all dependencies into dist/index.js so the runtime image needs no node_modules.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  platform: "node",
  target: "node20",
  noExternal: [/.*/],
  external: ["pg-native"],
  // CommonJS dependencies call require() for Node built-ins; give the ESM bundle one.
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});

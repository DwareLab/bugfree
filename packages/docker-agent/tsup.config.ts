import { defineConfig } from "tsup";

// One self-contained file (the core's DSN parser is bundled in), so the image needs no node_modules.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  platform: "node",
  target: "node20",
  noExternal: [/.*/],
  banner: { js: "#!/usr/bin/env node" },
});

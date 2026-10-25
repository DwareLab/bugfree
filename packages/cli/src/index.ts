import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const HELP = `bugfree — CLI for the bugfree error tracker

Usage:
  bugfree sourcemaps upload [dir] --release <version> [options]
  bugfree releases new <version>

Source map options:
  --release <version>   Release the maps belong to (must match the SDK's "release")
  --nextjs              Next.js preset: uploads .next/static and .next/server maps
  --url-prefix <prefix> Prefix for artifact names (default "~/"); e.g. "~/dist" when
                        your files are served or run from /…/dist
  --delete-after        Delete uploaded .map files that would be served publicly
                        (with --nextjs: only .next/static; server maps stay private)

Connection (or use the environment variables):
  --url <url>           API URL                       BUGFREE_URL
  --token <token>       Project secret key            BUGFREE_AUTH_TOKEN

Examples:
  bugfree sourcemaps upload --nextjs --release $GIT_SHA --delete-after
  bugfree sourcemaps upload dist --url-prefix ~/dist --release 1.4.0
`;

const CONCURRENCY = 4;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      release: { type: "string" },
      nextjs: { type: "boolean", default: false },
      "url-prefix": { type: "string" },
      "delete-after": { type: "boolean", default: false },
      url: { type: "string" },
      token: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [group, command, arg] = positionals;
  if (values.help || !group) {
    console.log(HELP);
    return;
  }
  const api = (values.url ?? process.env.BUGFREE_URL ?? "").replace(/\/+$/, "");
  const token = values.token ?? process.env.BUGFREE_AUTH_TOKEN ?? "";
  if (!api || !token) fail("Missing API URL or token. Pass --url/--token or set BUGFREE_URL and BUGFREE_AUTH_TOKEN.");

  if (group === "releases" && command === "new") {
    if (!arg) fail("Usage: bugfree releases new <version>");
    await request(api, token, "POST", "/api/cli/releases", JSON.stringify({ version: arg }), "application/json");
    console.log(`Created release ${arg}`);
    return;
  }

  if (group === "sourcemaps" && command === "upload") {
    const release = values.release ?? process.env.BUGFREE_RELEASE;
    if (!release) fail("--release is required");
    const files = values.nextjs ? await nextjsMaps(arg ?? ".next") : await genericMaps(arg ?? fail("Pass the directory to upload, or --nextjs"), values["url-prefix"] ?? "~/");
    if (!files.length) fail("No source maps found. Is source map generation enabled for your build?");
    console.log(`Uploading ${files.length} source map(s) for release ${release}…`);
    let done = 0;
    let bytes = 0;
    await pool(files, CONCURRENCY, async (file) => {
      const content = file.path ? await fs.readFile(file.path) : Buffer.from(file.inline ?? "", "utf8");
      bytes += content.length;
      await request(api, token, "POST", `/api/cli/releases/${encodeURIComponent(release)}/artifacts?name=${encodeURIComponent(file.name)}`, content, "application/octet-stream");
      done++;
      if (process.stdout.isTTY) process.stdout.write(`\r  ${done}/${files.length}`);
    });
    if (process.stdout.isTTY) process.stdout.write("\n");
    console.log(`Uploaded ${done} file(s), ${(bytes / 1024 / 1024).toFixed(1)} MB.`);
    if (values["delete-after"]) {
      const publicFiles = files.filter((f): f is MapFile & { path: string } => f.public && f.path !== null);
      await Promise.all(publicFiles.map((f) => fs.unlink(f.path)));
      console.log(`Deleted ${publicFiles.length} public .map file(s).`);
    }
    return;
  }

  fail(`Unknown command: ${positionals.join(" ")}\n\n${HELP}`);
}

interface MapFile {
  /** Map file on disk (null for inline data: URL maps). */
  path: string | null;
  /** Map contents, read lazily for files. */
  inline?: string;
  /** Served to browsers (deleted by --delete-after). */
  public: boolean;
  /** Artifact name: the JS file's path + ".map", e.g. "~/_next/static/chunks/main-abc.js.map". */
  name: string;
}

async function nextjsMaps(dir: string): Promise<MapFile[]> {
  // Browser chunks are served from /_next/static/…; server chunks run from <project>/.next/server/….
  return [
    ...(await collectMaps(path.join(dir, "static"), "~/_next/static", true)),
    ...(await collectMaps(path.join(dir, "server"), "~/.next/server", false)),
  ];
}

async function genericMaps(dir: string, prefix: string): Promise<MapFile[]> {
  return collectMaps(dir, prefix.replace(/\/+$/, ""), true);
}

const SOURCE_MAPPING_URL = /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/;

/**
 * Pairs every JS file with its source map via the `sourceMappingURL` comment (bundlers such as
 * Turbopack don't name maps `<file>.js.map`) and names the artifact after the JS file, which is what
 * appears in stack traces. Maps no JS file references are uploaded under their own name.
 */
async function collectMaps(root: string, prefix: string, isPublic: boolean): Promise<MapFile[]> {
  const files = await walk(root);
  const out: MapFile[] = [];
  const referenced = new Set<string>();
  for (const js of files.filter((f) => /\.(m|c)?js$/.test(f))) {
    const content = await fs.readFile(js, "utf8");
    const match = SOURCE_MAPPING_URL.exec(content.slice(-2000));
    if (!match) continue;
    const name = `${prefix}/${toPosix(path.relative(root, js))}.map`;
    const url = match[1];
    if (url.startsWith("data:")) {
      const comma = url.indexOf(",");
      const payload = url.slice(comma + 1);
      out.push({ path: null, inline: /;base64/.test(url.slice(0, comma)) ? Buffer.from(payload, "base64").toString("utf8") : decodeURIComponent(payload), public: false, name });
      continue;
    }
    const mapPath = path.resolve(path.dirname(js), decodeURIComponent(url.split(/[?#]/)[0]));
    try {
      await fs.access(mapPath);
    } catch {
      continue;
    }
    referenced.add(mapPath);
    out.push({ path: mapPath, public: isPublic, name });
  }
  for (const map of files.filter((f) => f.endsWith(".map"))) {
    if (!referenced.has(path.resolve(map))) out.push({ path: map, public: isPublic, name: `${prefix}/${toPosix(path.relative(root, map))}` });
  }
  return out;
}

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "cache") out.push(...(await walk(full)));
    } else if (/\.((m|c)?js|map)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const toPosix = (p: string) => p.split(path.sep).join("/");

async function request(api: string, token: string, method: string, pathname: string, body: BodyInit, contentType: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${api}${pathname}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": contentType },
        body,
      });
      if (res.ok) return;
      const text = await res.text();
      if (res.status < 500) fail(`HTTP ${res.status} from ${pathname}: ${text}`);
      lastError = new Error(`HTTP ${res.status}: ${text}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  throw lastError;
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

function fail(message: string): never {
  console.error(`bugfree: ${message}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

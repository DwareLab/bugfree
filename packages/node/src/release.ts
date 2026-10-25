import { execFileSync } from "node:child_process";

/** CI / hosting variables that carry the deployed commit. */
const RELEASE_ENV_VARS = [
  "BUGFREE_RELEASE",
  "NEXT_PUBLIC_BUGFREE_RELEASE",
  "VERCEL_GIT_COMMIT_SHA",
  "GITHUB_SHA",
  "CI_COMMIT_SHA",
  "RENDER_GIT_COMMIT",
  "RAILWAY_GIT_COMMIT_SHA",
  "HEROKU_SLUG_COMMIT",
  "SOURCE_VERSION",
  "CF_PAGES_COMMIT_SHA",
  "COMMIT_REF",
  "GIT_COMMIT",
];

let cached: string | null | undefined;

/**
 * Release name when none is configured: an explicit env var, a CI/hosting commit SHA, or the current
 * git commit. The CLI uses the same order, so a build and its source map upload agree.
 */
export function detectRelease(): string | undefined {
  if (cached !== undefined) return cached ?? undefined;
  for (const name of RELEASE_ENV_VARS) {
    const value = process.env[name]?.trim();
    if (value) return (cached = value);
  }
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"], timeout: 1000 }).toString().trim();
    cached = /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    cached = null;
  }
  return cached ?? undefined;
}

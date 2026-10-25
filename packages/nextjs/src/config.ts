import { detectRelease } from "@dwarelab/bugfree-node";

export interface WithBugfreeOptions {
  /** Release baked into the build. Default: BUGFREE_RELEASE, a CI commit SHA, or the current git commit. */
  release?: string;
  /** Generate browser and server source maps so stack traces can be un-minified. Default true. */
  sourceMaps?: boolean;
}

type NextConfigObject = Record<string, any>;
type NextConfigInput = NextConfigObject | ((...args: any[]) => NextConfigObject | Promise<NextConfigObject>);

/**
 * Wraps next.config: enables production source maps and exposes the release to client, server and
 * edge code as NEXT_PUBLIC_BUGFREE_RELEASE. The CLI detects the same release when uploading maps.
 */
export function withBugfree<T extends NextConfigInput>(nextConfig: T, options: WithBugfreeOptions = {}): T {
  const apply = (config: NextConfigObject): NextConfigObject => {
    const release = options.release ?? detectRelease();
    const sourceMaps = options.sourceMaps !== false;
    return {
      ...config,
      ...(sourceMaps ? { productionBrowserSourceMaps: true } : {}),
      experimental: { ...config.experimental, ...(sourceMaps ? { serverSourceMaps: true } : {}) },
      env: { ...config.env, ...(release ? { NEXT_PUBLIC_BUGFREE_RELEASE: release } : {}) },
    };
  };
  if (typeof nextConfig === "function") {
    return (async (...args: unknown[]) => apply(await nextConfig(...args))) as T;
  }
  return apply(nextConfig) as T;
}

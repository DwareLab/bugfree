import { type BrowserClient, type BrowserOptions, captureException, init as browserInit } from "@dwarelab/bugfree-browser";
import { Component, type ErrorInfo, type ReactNode, useEffect } from "react";

export * from "@dwarelab/bugfree-browser";

// Each `process.env.NEXT_PUBLIC_*` must be written out literally so Next.js can inline it at build time.
function env(): { dsn?: string; release?: string; environment?: string } {
  try {
    return {
      dsn: process.env.NEXT_PUBLIC_BUGFREE_DSN,
      release: process.env.NEXT_PUBLIC_BUGFREE_RELEASE,
      environment: process.env.NEXT_PUBLIC_BUGFREE_ENVIRONMENT ?? process.env.NODE_ENV,
    };
  } catch {
    return {};
  }
}

/** Browser-side init. Call it from `instrumentation-client.ts`. */
export function init(options: BrowserOptions = {}): BrowserClient {
  const fromEnv = env();
  return browserInit({
    dsn: fromEnv.dsn,
    release: fromEnv.release,
    environment: fromEnv.environment,
    ...options,
    initialTags: { runtime: "browser", ...options.initialTags },
  });
}

type ErrorWithDigest = Error & { digest?: string };

/**
 * Reports the error shown by an `error.tsx` / `global-error.tsx` boundary.
 * Server errors (they carry a `digest`) are skipped: `onRequestError` already reported them with the full stack.
 */
export function useReportError(error: ErrorWithDigest): void {
  useEffect(() => {
    if (error.digest) return;
    captureException(error, { mechanism: { type: "nextjs.errorBoundary", handled: true } });
  }, [error]);
}

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode | ((props: { error: Error; reset: () => void }) => ReactNode);
}

/** Catches render errors in its subtree, reports them and shows `fallback`. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    captureException(error, {
      mechanism: { type: "react.errorBoundary", handled: true },
      contexts: { react: { componentStack: info.componentStack ?? "" } },
    });
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { fallback } = this.props;
    return typeof fallback === "function" ? fallback({ error, reset: this.reset }) : (fallback ?? null);
  }
}

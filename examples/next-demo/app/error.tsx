"use client";

import { useReportError } from "@dwarelab/bugfree-nextjs/client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useReportError(error);
  return (
    <div>
      <h2>Something went wrong</h2>
      <p style={{ color: "#888" }}>{error.digest ? `Reference: ${error.digest}` : error.message}</p>
      <button onClick={reset}>Try again</button>
    </div>
  );
}

"use client";

import { useReportError } from "@bugfree/nextjs/client";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useReportError(error);
  return (
    <html lang="en">
      <body>
        <h2>Something went badly wrong</h2>
        <button onClick={reset}>Try again</button>
      </body>
    </html>
  );
}

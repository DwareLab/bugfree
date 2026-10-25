"use client";

// Renders different text on the server and in the browser: a classic hydration mismatch.
export default function HydrationPage() {
  return (
    <div>
      <p>
        <a href="/">← back</a>
      </p>
      <p>Rendered on: {typeof window === "undefined" ? "the server" : "the client"}</p>
    </div>
  );
}

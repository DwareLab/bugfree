"use client";

import { addBreadcrumb, captureMessage, setUser } from "@dwarelab/bugfree-nextjs/client";
import Link from "next/link";
import { useState } from "react";
import { cartTotal } from "@/lib/cart";
import { checkout } from "./actions";

export default function Home() {
  const [result, setResult] = useState<string>("");

  return (
    <main>
      <h1>next-demo</h1>
      <p>Each button produces a different kind of error for bugfree to capture.</p>
      <ul style={{ lineHeight: 2.2 }}>
        <li>
          <button
            id="btn-click"
            onClick={() => {
              setUser({ id: "u_42", email: "shopper@example.com" });
              addBreadcrumb({ category: "cart", message: "Opened cart with 1 item" });
              const total = cartTotal([{ sku: "SOCKS", price: 5, quantity: -1 }]);
              setResult(`Total: ${total}`);
            }}
          >
            Throw in a click handler
          </button>
        </li>
        <li>
          <button
            id="btn-promise"
            onClick={() => {
              void fetch("/api/does-not-exist").then(async (res) => {
                if (!res.ok) throw new Error(`Failed to load recommendations: HTTP ${res.status}`);
              });
            }}
          >
            Unhandled promise rejection
          </button>
        </li>
        <li>
          <button
            id="btn-api"
            onClick={async () => {
              const res = await fetch("/api/boom");
              setResult(`/api/boom responded ${res.status}`);
            }}
          >
            Call a failing route handler
          </button>
        </li>
        <li>
          <form
            action={async (formData) => {
              try {
                const r = await checkout(formData);
                setResult(`Checkout total: ${r.total}`);
              } catch {
                setResult("Checkout failed (server action error)");
              }
            }}
            style={{ display: "inline" }}
          >
            <button id="btn-action" type="submit">
              Server action with a bug
            </button>
          </form>
        </li>
        <li>
          <Link href="/server-error">Server component error</Link>
        </li>
        <li>
          <Link href="/render-error">Client render error (error boundary)</Link>
        </li>
        <li>
          <a href="/hydration">Hydration mismatch</a>
        </li>
        <li>
          <button
            id="btn-edge"
            onClick={async () => {
              const res = await fetch("/api/edge-boom");
              setResult(`/api/edge-boom responded ${res.status}`);
            }}
          >
            Edge route handler error
          </button>
        </li>
        <li>
          <button id="btn-message" onClick={() => captureMessage("User opened the legacy checkout", "warning")}>
            Send a message
          </button>
        </li>
      </ul>
      <p id="result">{result}</p>
    </main>
  );
}

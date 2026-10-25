"use client";

import { useState } from "react";

function PriceTag({ price }: { price: { amount: number } | null }) {
  return <strong>${price!.amount.toFixed(2)}</strong>;
}

export default function RenderErrorPage() {
  const [broken, setBroken] = useState(false);
  return (
    <div>
      <p>
        <a href="/">← back</a>
      </p>
      <button onClick={() => setBroken(true)}>Render a broken component</button>
      <p>{broken ? <PriceTag price={null} /> : <PriceTag price={{ amount: 9.5 }} />}</p>
    </div>
  );
}

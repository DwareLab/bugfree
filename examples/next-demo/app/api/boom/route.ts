import { cartTotal } from "@/lib/cart";

export async function GET() {
  const total = cartTotal([{ sku: "MUG", price: 12, quantity: 0 }]);
  return Response.json({ total });
}

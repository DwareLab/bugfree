"use server";

import { applyCoupon, cartTotal } from "@/lib/cart";

export async function checkout(formData: FormData) {
  const total = cartTotal([{ sku: "TSHIRT-M", price: 25, quantity: 2 }]);
  const coupon = formData.get("coupon") ? String(formData.get("coupon")) : undefined;
  return { total: applyCoupon(total, coupon) };
}

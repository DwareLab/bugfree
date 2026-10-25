export interface CartItem {
  sku: string;
  price: number;
  quantity: number;
}

export function cartTotal(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + lineTotal(item), 0);
}

function lineTotal(item: CartItem): number {
  if (item.quantity <= 0) {
    throw new RangeError(`Invalid quantity ${item.quantity} for ${item.sku}`);
  }
  return item.price * item.quantity;
}

export function applyCoupon(total: number, code: string | undefined): number {
  // Bug: code may be undefined when the user clears the field.
  const normalized = code!.trim().toUpperCase();
  return normalized === "HALF" ? total / 2 : total;
}

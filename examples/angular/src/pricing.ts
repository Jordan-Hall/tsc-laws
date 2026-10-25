// Pure money arithmetic in integer cents. `int` is an ordinary number at runtime; the prover treats it exactly.
import type { int } from 'tslaws';

export const MIN_QUANTITY = 1;
export const MAX_QUANTITY = 99;

export interface LineItem {
  id: string;
  name: string;
  unitCents: int;
  quantity: int;
}

export interface OrderSummary {
  subtotal: int;
  discount: int;
  tax: int;
  total: int;
}

export function lineTotal(unitCents: int, quantity: int): int {
  return (unitCents * quantity) as int;
}

export function subtotal(items: LineItem[]): int {
  let sum = 0;
  for (const item of items) sum += lineTotal(item.unitCents, item.quantity);
  return sum as int;
}

/** Discount tier in basis points: 10% from 100.00, 5% from 50.00, otherwise none. */
export function discountTierBps(subtotalCents: int): int {
  if (subtotalCents >= 10000) return 1000 as int;
  if (subtotalCents >= 5000) return 500 as int;
  return 0 as int;
}

/** The tier's share of the subtotal, rounded down, so it never exceeds the subtotal. */
export function discountCents(subtotalCents: int): int {
  return Math.floor((subtotalCents * discountTierBps(subtotalCents)) / 10000) as int;
}

/** Tax on a taxable amount at `rateBps` basis points (2000 = 20%), rounded half up to whole cents. */
export function taxCents(taxableCents: int, rateBps: int): int {
  return Math.floor((taxableCents * rateBps + 5000) / 10000) as int;
}

export function orderSummary(items: LineItem[], rateBps: int): OrderSummary {
  const sub = subtotal(items);
  const discount = discountCents(sub);
  const tax = taxCents((sub - discount) as int, rateBps);
  return { subtotal: sub, discount, tax, total: (sub - discount + tax) as int };
}

/** Turns whatever a person typed into a quantity in [MIN_QUANTITY, MAX_QUANTITY]; junk becomes the minimum. */
export function clampQuantity(raw: number): int {
  if (!(raw >= MIN_QUANTITY)) return MIN_QUANTITY as int; // also catches NaN
  return Math.min(MAX_QUANTITY, Math.max(MIN_QUANTITY, Math.trunc(raw))) as int;
}

export function formatCents(cents: int): string {
  const whole = Math.floor(cents / 100);
  const rest = cents - whole * 100;
  return `$${whole}.${rest < 10 ? '0' : ''}${rest}`;
}

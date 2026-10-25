// What a shopper pays, in whole pence: the basket price less a coupon, never below nothing.
export function total(price: number, coupon: number): number {
  return Math.max(0, price - coupon);
}

import type { int } from 'tslaws';
import { assume } from 'tslaws';
import { total } from './cart';

// A shopper is never charged a negative amount, whatever the basket and the coupon.
export law totalNeverNegative(price: int, coupon: int) {
  assume(price >= 0 && coupon >= 0);
  return total(price, coupon) >= 0;
}

// A coupon never makes the basket cost more.
export law couponNeverRaisesTheTotal(price: int, coupon: int) {
  assume(price >= 0 && coupon >= 0);
  return total(price, coupon) <= price;
}

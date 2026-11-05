import type { int } from 'tslaws';
import { assume } from 'tslaws';
import { total } from './cart';

// Proposed: a coupon of zero changes nothing.
export law zeroCouponChangesNothing(price: int) {
  assume(price >= 0);
  return total(price, 0) === price;
}

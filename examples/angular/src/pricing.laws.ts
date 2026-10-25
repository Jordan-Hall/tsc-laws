import { assume } from 'tslaws';
import type { int } from 'tslaws';
import {
  MAX_QUANTITY,
  MIN_QUANTITY,
  clampQuantity,
  discountCents,
  discountTierBps,
  formatCents,
  lineTotal,
  orderSummary,
  subtotal,
  taxCents,
  type LineItem,
} from './pricing';

export law proved lineTotalNeverNegative(unit: int, qty: int) {
  assume(unit >= 0 && unit <= 1_000_000 && qty >= 0 && qty <= 99);
  return lineTotal(unit, qty) >= 0;
}

export law proved discountTierNeverExceedsWholePrice(sub: int) {
  assume(sub >= 0 && sub <= 100_000_000);
  const bps = discountTierBps(sub);
  // sub * bps / 10000 <= sub, written without a division
  return bps >= 0 && bps <= 1000 && sub * bps <= sub * 10000;
}

export law discountNeverExceedsSubtotal(sub: int) {
  assume(sub >= 0 && sub <= 100_000_000);
  const d = discountCents(sub);
  return d >= 0 && d <= sub;
}

export law proved discountTierIsMonotonic(a: int, b: int) {
  assume(a >= 0 && a <= b && b <= 100_000_000);
  return discountTierBps(a) <= discountTierBps(b);
}

export law clampStaysInRange(raw: number) {
  const q = clampQuantity(raw);
  return q >= MIN_QUANTITY && q <= MAX_QUANTITY;
}

export law taxIsRoundedHalfUp(taxable: int, rate: int) {
  assume(taxable >= 0 && taxable <= 10_000_000 && rate >= 0 && rate <= 10_000);
  const tax = taxCents(taxable, rate);
  // within half a cent of the exact tax, i.e. |tax - taxable*rate/10000| <= 1/2
  return Math.abs(tax * 10000 - taxable * rate) <= 5000;
}

export law subtotalIsSumOfLines(items: LineItem[]) {
  assume(items.length <= 5);
  assume(items.every((i) => i.unitCents >= 0 && i.unitCents <= 100_000 && i.quantity >= 0 && i.quantity <= 99));
  let expected = 0;
  for (const i of items) expected += i.unitCents * i.quantity;
  return subtotal(items) === expected;
}

export law summaryAddsUp(items: LineItem[], rate: int) {
  assume(items.length <= 5 && rate >= 0 && rate <= 10_000);
  assume(items.every((i) => i.unitCents >= 0 && i.unitCents <= 100_000 && i.quantity >= 0 && i.quantity <= 99));
  const s = orderSummary(items, rate);
  return s.total === s.subtotal - s.discount + s.tax && s.total >= 0 && s.discount <= s.subtotal;
}

export law formatCentsShowsDollarsAndCents(cents: int) {
  assume(cents >= 0 && cents <= 100_000_000);
  const text = formatCents(cents);
  return /^\$\d+\.\d\d$/.test(text) && Math.round(Number(text.slice(1)) * 100) === cents;
}

export law discountTiersStartExactlyAtTheirEdge(edge: 5000 | 10000, below: 1 | 2 | 10) {
  const bps = discountTierBps(edge as int);
  return bps === (edge === 5000 ? 500 : 1000) && discountTierBps((edge - below) as int) < bps;
}

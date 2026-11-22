import { law, assume } from 'tslaws';
import type { int } from 'tslaws';
import { countUp, largest, average, half, clampAbove } from './math';

const small = (n: int) => n > -1_000_000 && n < 1_000_000;

// Straight-line arithmetic: the shape cvc5 and Carcara certify today.
law.proved('addition commutes', (a: int, b: int) => a + b === b + a);
law.proved('doubling is adding twice', (a: bigint) => a * 2n === a + a);
law.proved('and commutes', (a: boolean, b: boolean) => (a && b) === (b && a));
law.proved('counting up reaches n', (n: int) => {
  assume(n >= 0 && n < 1_000_000);
  return countUp(n) === n;
});
law.proved('the largest is never negative', (xs: int[]) => largest(xs) >= 0);
law('the average sits between', (a: number, b: number) => {
  assume(a <= b);
  return average(a, b) >= a && average(a, b) <= b;
});
law.proved('half is at most n', (n: int) => {
  assume(n >= 0 && n < 1_000_000);
  return half(n) <= n;
});
law.proved('clamping never goes below the floor', (x: int, lo: int) => {
  assume(small(x) && small(lo));
  return clampAbove(x, lo) >= lo;
});

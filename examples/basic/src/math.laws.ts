import { assume } from 'tslaws';
import { add, clamp, sortNumbers, manhattan, type Point } from './math';

export law addCommutes(a: number, b: number) => add(a, b) === add(b, a);

export law proved addIdentity(a: number) => add(a, 0) === a;

export law clampWithinBounds(x: number, lo: number, hi: number) {
  assume(lo <= hi);
  const y = clamp(x, lo, hi);
  return y >= lo && y <= hi;
}

export law sortKeepsLength(xs: number[]) => sortNumbers(xs).length === xs.length;

export law manhattanSymmetric(p: Point, q: Point) => manhattan(p, q) === manhattan(q, p);

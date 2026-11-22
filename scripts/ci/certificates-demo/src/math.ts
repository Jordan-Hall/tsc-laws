import type { int } from 'tslaws';

export function countUp(n: int): int {
  let i = 0;
  while (i < n) {
    i = i + 1;
  }
  return i as int;
}
export function largest(xs: int[]): int {
  let m = 0;
  let i = 0;
  while (i < xs.length) {
    if (xs[i] > m) m = xs[i];
    i += 1;
  }
  return m as int;
}
export function average(a: number, b: number): number {
  return (a + b) / 2;
}
export function half(n: int): int {
  return Math.floor(n / 2) as int;
}
export function clampAbove(x: int, lo: int): int {
  return (x < lo ? lo : x) as int;
}

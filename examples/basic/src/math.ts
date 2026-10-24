export function add(a: number, b: number): number {
  return a + b;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

/** Buggy on purpose: drops duplicates. */
export function sortNumbers(xs: number[]): number[] {
  return [...new Set(xs)].sort((a, b) => a - b);
}

export interface Point {
  x: number;
  y: number;
}

export function manhattan(p: Point, q: Point): number {
  return Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
}

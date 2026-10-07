/** A point in the plane. */
export interface Point {
  readonly x: number;
  y: number;
}

export enum Color {
  Red,
  Green = 'green',
  Blue = 4,
}

export const enum Flag {
  A = 1 << 0,
  B = 1 << 1,
}

export abstract class Shape<T extends object = Point> {
  static count = 0;
  #id = Shape.count++;
  constructor(public readonly origin: T) {}
  abstract area(): number;
  get id(): number {
    return this.#id;
  }
}

export class Circle extends Shape {
  constructor(
    origin: Point,
    private radius: number,
  ) {
    super(origin);
  }
  area(): number {
    return Math.PI * this.radius ** 2;
  }
}

export type Pair<A, B = A> = [first: A, second?: B, ...rest: string[]];
export type Keys<T> = keyof T;
export type Getter<T> = { [K in keyof T as `get${Capitalize<string & K>}`]: () => T[K] };
export type Unwrap<T> = T extends Promise<infer U> ? U : T;
export type Indexed = Point['x'];
export type Big = 10n | -3n;

export function isCircle(s: Shape): s is Circle {
  return s instanceof Circle;
}

export function assertPoint(value: unknown): asserts value is Point {}

export default function distance(this: void, a: Point, b: Point = { x: 0, y: 0 }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

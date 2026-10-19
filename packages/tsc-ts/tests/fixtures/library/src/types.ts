/** A point in the plane. */
export interface Point {
  readonly x: number;
  y?: number;
}

export class Base<T> {
  constructor(readonly value: T) {}
  get doubled(): T[] {
    return [this.value, this.value];
  }
}

export class Derived extends Base<string> implements Point {
  x = 1;
  static create(): Derived {
    return new Derived('a');
  }
}

export enum Color {
  Red,
  Green = 'green',
}

export const enum Flags {
  None = 0,
  A = 1 << 0,
  B = 1 << 1,
}

export type Pair<A, B = A> = [first: A, second?: B, ...rest: boolean[]];
export type Keys<T> = keyof T;
export type Loud<S extends string> = Uppercase<S>;
export type Route<P extends string> = `/${P}/${number}`;
export type ElementOf<T> = T extends readonly (infer E)[] ? E : never;
export type Picked<T, K extends keyof T> = { [P in K]: T[P] };
export type Lookup<T, K extends keyof T> = T[K];
export type Maybe<T> = T | undefined | null;
export const big = 12345678901234567890n;
export const sym: unique symbol = Symbol('sym');

export function isPoint(value: unknown): value is Point {
  return typeof value === 'object' && value !== null && 'x' in value;
}

export function assertDefined<T>(value: T | undefined): asserts value is T {
  if (value === undefined) throw new Error('undefined');
}

export function overloaded(value: string): string;
export function overloaded(value: number): number;
export function overloaded(value: string | number): string | number {
  return value;
}

export namespace Shapes {
  export const unit: Point = { x: 1 };
  export function scale(p: Point, by: number): Point {
    return { x: p.x * by, y: (p.y ?? 0) * by };
  }
}

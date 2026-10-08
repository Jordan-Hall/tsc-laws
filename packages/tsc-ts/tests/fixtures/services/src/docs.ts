/**
 * Adds two numbers.
 * See {@link subtract} and {@linkcode Shape.area | the area} or {@link https://example.com|the site}.
 * Also {@link missingThing some text} and {@linkplain https://example.org}.
 * @param a The first number.
 * @param b - The second number.
 * @returns The sum.
 * @throws {RangeError} When too big.
 * @see subtract for the opposite
 * @example <caption>Simple</caption>
 * add(1, 2);
 * @deprecated Use plus.
 * @since 1.0
 */
export function add(a: number, b: number): number {
  return a + b;
}

/** Subtracts. */
export function subtract(a: number, b: number): number;
export function subtract(a: string, b: string): string;
export function subtract(a: any, b: any): any {
  return a - b;
}

/**
 * Identity.
 * @template T The value type.
 * @template {string} K A key.
 */
export function identity<T, K extends string>(value: T, key?: K): T {
  void key;
  return value;
}

/** A shape. */
export abstract class Shape {
  /** The name. */
  name = 'shape';
  /** Area of the shape. */
  abstract area(): number;
  /** Creates a shape. */
  static create(): Shape | undefined {
    return undefined;
  }
}

export class Square extends Shape {
  constructor(public side: number) {
    super();
  }
  area(): number {
    return this.side * this.side;
  }
  static create(): Square {
    return new Square(1);
  }
}

/** Options for drawing. */
export interface Options {
  /** Line width. */
  width?: number;
  /** Fill colour. */
  fill: string;
}

/**
 * Draws.
 * @param options The options.
 * @param param1 The position.
 */
export function draw({ width, fill }: Options, [x, y]: [number, number]): void {
  void width;
  void fill;
  void x;
  void y;
}

/** The answer. */
export const answer = 42,
  other = 1;

/** A callback. */
export const callback = () => answer;

/** A pair. */
export type Pair<A, B> = [A, B];

/** Colours. */
export enum Colour {
  /** Red. */
  Red,
  Green,
}

/** A namespace. */
export namespace Space {
  /** Inside. */
  export const inside = 1;
}

const square = new Square(2);
const { fill: chosen } = { fill: 'red' } as Options;
console.log(add(1, 2), subtract(3, 1), identity('x'), square.area(), Square.create(), chosen, Space.inside, other);

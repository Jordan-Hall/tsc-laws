import distance, { Circle, Color, Flag, isCircle, type Pair, type Point, type Getter } from './shapes.ts';
import * as shapes from './shapes.ts';
export { Color as Colour } from './shapes.ts';
import { double } from '@lib/util.js';

declare module './shapes.ts' {
  interface Point {
    label?: string;
  }
}

// Non-ASCII text moves UTF-16 positions away from UTF-8 offsets: ünïcödé ✓ 𝒳
const greeting = `héllo ${'wörld'} 𝒳`;
const tag = (strings: TemplateStringsArray, ...values: unknown[]) => strings.raw.join('|') + values.length;
const tagged = tag`a${1}b${2}c`;

const circle = new Circle({ x: 1, y: 2 }, 3);
const pair: Pair<number> = [1, 2, 'x'];
const flags = Flag.A | Flag.B;
const color: Color = Color.Green;
const maybe: string | undefined = Math.random() > 0.5 ? 'yes' : undefined;
const big = 12345678901234567890n;
const record: Record<string, Point> = {};
const readonlyTuple = [1, 'two'] as const;
const getter: Getter<Point> = { getX: () => 1, getY: () => 2, getLabel: () => undefined };
let lazy: Promise<number[]> | undefined;

function* counter(limit: number): Generator<number, void, unknown> {
  for (let i = 0; i < limit; i++) yield i;
}

async function load(): Promise<Map<string, Set<number>>> {
  const values = await (lazy ?? Promise.resolve([1, 2]));
  return new Map([['a', new Set(values)]]);
}

function overload(x: string): string;
function overload(x: number): number;
function overload(x: string | number): string | number {
  return x;
}

class Box<T> implements Iterable<T> {
  [key: string]: unknown;
  constructor(private items: T[] = []) {}
  *[Symbol.iterator](): Iterator<T> {
    yield* this.items;
  }
  map<U>(f: (item: T, index: number) => U): Box<U> {
    return new Box(this.items.map(f));
  }
}

const box = new Box([circle]).map((c) => c.area());
const total = [...box].reduce((a, b) => a + b, 0);
const shorthand = { total, greeting };
const { total: renamed, ...others } = shorthand;

if (isCircle(circle) && maybe !== undefined) {
  console.log(distance({ x: 0, y: 0 }, circle.origin), maybe.toUpperCase(), color, flags, pair[0]);
}

for (const n of counter(3)) console.log(n, big, record, readonlyTuple, getter.getX(), tagged, renamed, others);
void load().then((m) => m.get('a'), double);
console.log(overload('x'), overload(1), shapes.Color.Red);

// Errors for the diagnostics methods.
const wrong: number = 'not a number';
undefinedName();
export const unused = (p: Point) => p.z;

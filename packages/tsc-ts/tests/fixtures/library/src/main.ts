import { Base, Color, Derived, Flags, isPoint, overloaded, Shapes, type ElementOf, type Keys, type Loud, type Lookup, type Maybe, type Pair, type Picked, type Point, type Route } from './types.js';
import * as types from './types.js';

export default function distance(this: void, a: Point, b: Point = Shapes.unit): number {
  return Math.hypot(a.x - b.x, (a.y ?? 0) - (b.y ?? 0));
}

const pair: Pair<string, number> = ['a', 1, true];
const keys: Keys<Point> = 'x';
const loud: Loud<'hi'> = 'HI';
const route: Route<'users'> = '/users/1';
const element: ElementOf<string[]> = 'e';
const picked: Picked<Point, 'x'> = { x: 2 };
const looked: Lookup<Point, 'y'> = 3;
const maybe: Maybe<Derived> = Derived.create();
const color = Color.Green;
const flags = Flags.A | Flags.B;
const literal = 'text' as const;
const values = [1, 2, 3].map((n) => n * 2);
const record: Record<string, Base<number>> = { one: new Base(1) };
const x = 1;
const shorthand = { x };
function generic<T extends { length: number }>(value: T): T {
  return value;
}
const fromGeneric = generic('abc');
const json = JSON.stringify({ pair, keys, loud, route, element, picked, looked, maybe, color, flags, literal, values, record, shorthand, fromGeneric });
if (isPoint(json)) overloaded(json.x);
overloaded('s');
export { types, json };

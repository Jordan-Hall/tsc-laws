import { Shape, type Options, Mode } from './shapes.ts';
import * as shapes from './shapes.ts';

export interface Point {
  readonly x: number;
  y?: number;
  'with space': string;
  /** @deprecated Use x. */
  legacy: number;
  [Symbol.iterator](): Iterator<number>;
}

declare const point: Point;
declare const maybe: Point | undefined;
declare const promised: Promise<Point>;

point.x;
maybe?.y;
maybe.x;
shapes.Mode.A;
const s = new Shape();
s.area();
Mode.B;

class Base {
  protected hidden = 1;
  private secret = 2;
  static make(): Base {
    return new Base();
  }
  greet(): string {
    return 'hi';
  }
}

class Derived extends Base {
  #own = 3;
  method() {
    this.hidden;
    this.#own;
    super.greet();
  }

}

Derived.make();

interface Named {
  name: string;
  kind: 'circle' | 'square' | 'triangle';
}

interface Shaped extends Named {

}

const options: Options = { size: 1,  };
const named: Named = { name: 'n', kind: 'circle' };
const { name, } = named;
function take(o: Named) {}
take({ kind: 'square',  });
take({ kind: '' });
named.kind === 'circle';
const k: Named['kind'] = 'square';
type K = Named[''];
const el = named[''];
'kind' in named;

switch (named.kind) {
  case 'circle':
    break;
  case '':
}

function tagged(strings: TemplateStringsArray, ...values: ('a' | 'b')[]) {}
tagged`x${''}`;

declare function overloaded(x: 'one'): void;
declare function overloaded(x: 'two', y: number): void;
overloaded('');

async function run() {
  const p = await promised;
  p.x;
  promised.then;
}

namespace Outer {
  export namespace Inner {
    export const value = 1;
  }
  export type T = number;
}
let q: Outer.Inner.value;
let t: Outer.T;
type Imported = import('./shapes.ts').Shape;

/**
 * Adds numbers.
 * @param a first
 * @
 */
function add(a: number, b: number) {
  return a + b;
}

/** @param  */
function sub(left: number, right: number) {
  return left - right;
}

/**  */
function noop() {}

label: for (;;) {
  break label;
  continue label;
}

const arr = [1, 2, 3];
arr.map((v) => v.toFixed);
const big = 10n;
1..toFixed;
export { name };
export { Shape as Renamed } from './shapes.ts';
export {  } from './shapes.ts';

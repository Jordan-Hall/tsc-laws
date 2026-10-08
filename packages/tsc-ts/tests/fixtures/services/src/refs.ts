import { add as plus, Shape, Square, type Options } from './docs.ts';
import * as docs from './docs.ts';
import defaultThing, { helper } from './helpers.ts';
export { Square as Box } from './docs.ts';
export * from './helpers.ts';

const total = plus(1, 2) + docs.add(3, 4) + helper();
const shape: Shape = new Square(3);
const options: Options = { fill: 'blue', width: 2 };
const { fill, width = 1 } = options;
const fill2 = { fill };

class Counter {
  static instances = 0;
  count = 0;
  constructor() {
    Counter.instances++;
    this.count = 0;
  }
  increment(this: Counter): this {
    this.count++;
    return this;
  }
  static reset() {
    this.instances = 0;
  }
}

class Derived extends Counter {
  constructor() {
    super();
    super.increment();
  }
}

outer: for (const n of [1, 2]) {
  inner: for (const m of [3, 4]) {
    if (n === m) continue outer;
    if (m > 3) break inner;
  }
}

type Kind = 'circle' | 'square';
const kind: Kind = 'circle';
type Tagged = { type: 'a'; value: number } | { type: 'b'; value: string };
declare const tagged: Tagged;
const v = tagged.value;
const keyed = options['fill'];

function usesThis(this: { n: number }) {
  return this.n;
}

let readonlyList: readonly string[] = [];
const derived = new Derived();
derived.increment().increment();
console.log(total, shape, fill, width, fill2, kind, v, keyed, usesThis, readonlyList, defaultThing, import.meta.url);
export default derived;

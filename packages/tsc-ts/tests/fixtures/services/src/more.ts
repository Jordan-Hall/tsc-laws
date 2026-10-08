/// <reference path="./global.ts" />
import type * as Helpers from './helpers.ts';
import { shared as sharedName } from './helpers.ts';
export * as helpers from './helpers.ts';
export { sharedName as sharedAlias };

interface Base {
  /** The id. */
  id: number;
  describe(): string;
}

interface Named extends Base {
  name: string;
}

abstract class Entity implements Named {
  id = 0;
  name = '';
  #secret = 1;
  private hidden = 2;
  protected guarded = 3;
  static count = 0;
  describe(): string {
    return `${this.id} ${this.name} ${this.#secret} ${this.hidden} ${this.guarded}`;
  }
  get label(): string {
    return this.name;
  }
  set label(value: string) {
    this.name = value;
  }
}

class User extends Entity {
  constructor(
    readonly email: string,
    private age = 0,
  ) {
    super();
    Entity.count++;
  }
  override describe(): string {
    return super.describe() + this.email + this.age;
  }
}

const user = new User('a@b.c');
user.label = user.describe();
const named: Named = { id: 1, name: 'n', describe: () => 'd' };
const { id, ...restOfNamed } = named;
let a: number, b: number;
({ id: a, name: b } = { id: 1, name: 2 } as unknown as { id: number; name: number });
for (const { id: loopId } of [named]) void loopId;
[a, b] = [b, a];

type Shape = { kind: 'circle'; radius: number } | { kind: 'square'; side: number };
function area(shape: Shape): number {
  switch (shape.kind) {
    case 'circle':
      return shape.radius;
    case 'square':
      return shape.side;
  }
}
const circle: Shape = { kind: 'circle', radius: 1 };
const spread = { ...named, extra: true };
const mapped: { readonly [K in keyof Base]: Base[K] } = named;
const keyed = named['name'] + mapped.id + spread.extra;

enum Direction {
  Up = 1,
  Down = Up + 1,
}
const direction = Direction.Down;

namespace Outer.Inner {
  export const value = 1;
}
namespace Outer {
  export const other = Inner.value;
}
declare module 'virtual' {
  export const virtualValue: number;
}
import { virtualValue } from 'virtual';

const computed = { ['key']: 1, 2: 'two', 'quoted': 3 };
const literal = computed.key + computed[2] + computed.quoted;
const typeQuery: typeof import('./helpers.ts') = null!;
type HelperFn = typeof Helpers.helper | typeof import('./helpers.ts').helper;
const obj = {
  count: 0,
  inc() {
    return this.count++;
  },
  arrow: () => this,
};
function overload(x: string): string;
function overload(x: number): number;
function overload(x: unknown) {
  return x;
}
overload(1);
overload('x');
export default class {}
console.log(user, id, restOfNamed, area(circle), keyed, direction, Outer.other, virtualValue, literal, typeQuery, obj);
export type { HelperFn };

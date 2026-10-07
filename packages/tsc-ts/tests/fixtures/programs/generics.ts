enum Kind {
  Leaf,
  Node,
}

type Tree<T> = { kind: Kind.Leaf; value: T } | { kind: Kind.Node; left: Tree<T>; right: Tree<T> };

function sum(tree: Tree<number>): number {
  switch (tree.kind) {
    case Kind.Leaf:
      return tree.value;
    case Kind.Node:
      return sum(tree.left) + sum(tree.right);
  }
}

function leaf<T>(value: T): Tree<T> {
  return { kind: Kind.Leaf, value };
}

class Stack<T> {
  private items: T[] = [];
  push(item: T): this {
    this.items.push(item);
    return this;
  }
  pop(): T | undefined {
    return this.items.pop();
  }
  get size(): number {
    return this.items.length;
  }
}

function pairs<V>(record: Record<string, V>): [string, V][] {
  const out: [string, V][] = [];
  for (const key of Object.keys(record)) out.push([key, record[key]]);
  return out;
}

const tree: Tree<number> = {
  kind: Kind.Node,
  left: leaf(1),
  right: { kind: Kind.Node, left: leaf(2), right: leaf(3) },
};
const stack = new Stack<string>().push('a').push('b');
const words = new Map<string, number>();
for (const w of 'the quick brown fox jumps over the lazy dog the end'.split(' ')) words.set(w, (words.get(w) ?? 0) + 1);
const unique = new Set([3, 1, 3, 2, 1]);
const [first, ...rest] = [...unique].sort((a, b) => a - b);
const maybe: string | null = stack.size > 1 ? (stack.pop() ?? null) : null;

console.log(sum(tree), stack.size, maybe?.toUpperCase(), words.get('the'), first, rest.length);
console.log(
  pairs({ a: 1, b: 2 })
    .map(([k, v]) => `${k}=${v}`)
    .join('&'),
);

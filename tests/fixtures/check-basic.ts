// Checker fixture: assignability, property access, inference.
let x: number = "hello";
function f(a: string): number { return a; }
const o = { a: 1 };
o.b;
class C { m(): void {} }
new C().n();
let y = [1, 2, 3].map(v => v.toUpperCase());

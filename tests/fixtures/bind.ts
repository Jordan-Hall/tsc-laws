// Binder fixture: declarations, merging, scopes, and bind errors.
namespace N { export const a = 1; export namespace Inner { export function f() {} } }
namespace N { export const b = 2; }
enum E { A, B }
enum E { C = 2 }
interface I { x: number }
interface I { y: string }
class C { static s = 1; #p = 2; m() { return this.#p; } get g() { return 1; } set g(v) {} }
function overload(a: string): void;
function overload(a: number): void;
function overload(a: any) {}
let dup = 1;
let dup = 2;
function f(arguments: number, eval: string) { "use strict"; }
label: { break label; }
for (const { a, b: [c] } of []) { var hoisted = a + c; }
type Alias<T> = T extends infer U ? U : never;
declare module "mod" { export const m: number; }
declare global { interface Window { extra: string } }
export default class {}
export { N as Renamed };
import type { X } from "./x";
const fn = function named() { return named; };
with (obj) {}

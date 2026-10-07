// Language support for code translated from Go by tools/gots.
//
// Strings are byte strings: each UTF-16 code unit holds one byte of the Go
// string's UTF-8 encoding. Indexing, lengths and slicing then match Go.

export class GoObject {
  Error(): string {
    throw unimplementedMethod('Error');
  }
  String(): string {
    throw unimplementedMethod('String');
  }
}

// Ptr is a Go pointer to a non-struct value: either a fresh value (new(T))
// or an existing variable, field or element reached through closures.
export class Ptr<T> extends GoObject {
  v: T;
  g: (() => T) | undefined;
  s: ((v: T) => void) | undefined;
  constructor(v: T, g: (() => T) | undefined = undefined, s: ((v: T) => void) | undefined = undefined) {
    super();
    this.v = v;
    this.g = g;
    this.s = s;
  }
  get(): T {
    return this.g === undefined ? this.v : this.g();
  }
  set(v: T): void {
    if (this.s === undefined) this.v = v;
    else this.s(v);
  }
}

// Box carries a non-class value inside an interface, tagged with its Go type.
export class Box<T> extends GoObject {
  v: T;
  t: string;
  constructor(v: T, t: string) {
    super();
    this.v = v;
    this.t = t;
  }
}

// Boxes for basic values, so unboxing narrows with instanceof.
export class BoxNum extends GoObject {
  v: number;
  t: string;
  constructor(v: number, t: string) {
    super();
    this.v = v;
    this.t = t;
  }
}
export class BoxStr extends GoObject {
  v: string;
  t: string;
  constructor(v: string, t: string) {
    super();
    this.v = v;
    this.t = t;
  }
}
export class BoxBool extends GoObject {
  v: boolean;
  t: string;
  constructor(v: boolean, t: string) {
    super();
    this.v = v;
    this.t = t;
  }
}

export class Empty extends GoObject {}
export const EMPTY = new Empty();
export const EMPTY_MAP: Map<never, never> = new Map<never, never>();

// boxAny boxes a value of a type parameter stored in an interface.
export function boxAny<T>(v: T): GoObject | undefined {
  return new Box<T>(v, 'generic');
}

export function isValue(v: GoObject | undefined, t: string): boolean {
  if (v instanceof BoxNum) return v.t === t;
  if (v instanceof BoxStr) return v.t === t;
  if (v instanceof BoxBool) return v.t === t;
  if (v instanceof Box) return v.t === t;
  return false;
}

export function hasMethods(v: GoObject | undefined, names: string[]): boolean {
  return v !== undefined && names.length >= 0;
}

export function ifaceEq(a: GoObject | undefined, b: GoObject | undefined): boolean {
  if (a === b) return true;
  if (a instanceof BoxNum && b instanceof BoxNum) return a.t === b.t && a.v === b.v;
  if (a instanceof BoxStr && b instanceof BoxStr) return a.t === b.t && a.v === b.v;
  if (a instanceof BoxBool && b instanceof BoxBool) return a.t === b.t && a.v === b.v;
  return false;
}

// Panics.

// Panic is thrown for Go panics. It is a plain class rather than an Error
// subclass, which scriptc would have to represent dynamically.
export class Panic extends GoObject {
  value: GoObject | undefined;
  recovered = false;
  constructor(value: GoObject | undefined) {
    super();
    this.value = value;
  }
  message(): string {
    return panicMessage(this.value);
  }
}

function panicMessage(v: GoObject | undefined): string {
  if (v === undefined) return 'panic: nil';
  if (v instanceof BoxStr) return 'panic: ' + v.v;
  if (v instanceof BoxNum) return 'panic: ' + String(v.v);
  if (v instanceof GoError) return 'panic: ' + v.msg;
  return 'panic';
}

export function panic(v: GoObject | undefined): never {
  throw new Panic(v);
}

export function toPanic(e: unknown): Panic {
  if (e instanceof Panic) return e;
  if (e instanceof Error) return new Panic(new BoxStr(e.message, 'string'));
  return new Panic(new BoxStr('panic', 'string'));
}

let current: Panic | undefined = undefined;

// runDefers runs deferred calls in reverse order. A deferred call may recover
// the active panic; a panic raised by a deferred call replaces it.
export function runDefers(defers: (() => void)[], p: Panic | undefined): Panic | undefined {
  let active = p;
  for (let i = defers.length - 1; i >= 0; i--) {
    const saved = current;
    current = active;
    try {
      defers[i]();
      active = current;
    } catch (e) {
      active = toPanic(e);
    }
    current = saved;
  }
  return active;
}

export function recover(): GoObject | undefined {
  const p = current;
  if (p === undefined) return undefined;
  current = undefined;
  p.recovered = true;
  return p.value;
}

export function unsupported(what: string): Error {
  return new Error('unsupported: ' + what);
}

export function unsupportedAs<T>(what: string): T {
  throw new Error('unsupported: ' + what);
}

export function unimplementedMethod(name: string): Error {
  return new Error('method not implemented: ' + name);
}

export function typeAssertFail<T>(): T {
  throw new Panic(new Box<string>('interface conversion', 'string'));
}

export function newPanic(v: GoObject | undefined): Panic {
  return new Panic(v);
}

// panicValue raises a panic from an expression position.
export function panicValue(v: GoObject | undefined): void {
  throw new Panic(v);
}

export class GoError extends GoObject {
  msg: string;
  constructor(msg: string) {
    super();
    this.msg = msg;
  }
  override Error(): string {
    return this.msg;
  }
}

// Slices.

export function makeSlice<T>(n: number, zero: T): T[] {
  const a: T[] = [];
  for (let i = 0; i < n; i++) a.push(zero);
  return a;
}

export function makeSliceFn<T>(n: number, zero: () => T): T[] {
  const a: T[] = [];
  for (let i = 0; i < n; i++) a.push(zero());
  return a;
}

export function makeArray<T>(n: number, zero: () => T): T[] {
  return makeSliceFn<T>(n, zero);
}

export function indexedArray<T>(n: number, entries: [number, T][], zero: () => T): T[] {
  const a = makeSliceFn<T>(n, zero);
  for (const [i, v] of entries) a[i] = v;
  return a;
}

export function appendCopy<T>(s: T[], items: T[]): T[] {
  const out = s.slice();
  for (let i = 0; i < items.length; i++) out.push(items[i]);
  return out;
}

export function appendInto<T>(s: T[], items: T[]): void {
  const n = items.length;
  for (let i = 0; i < n; i++) s.push(items[i]);
}

export function copySlice<T>(dst: T[], src: T[]): number {
  const n = Math.min(dst.length, src.length);
  if (dst === src) return n;
  for (let i = 0; i < n; i++) dst[i] = src[i];
  return n;
}

export function clearSlice<T>(s: T[], zero: T): void {
  for (let i = 0; i < s.length; i++) s[i] = zero;
}

export function mapLen<K, V>(m: Map<K, V> | undefined): number {
  return m === undefined ? 0 : m.size;
}

export function assignFields<T>(o: T, _fields: unknown): T {
  return o;
}

export function structKey(v: GoObject): string {
  return String(objectId(v));
}

export function structEq(a: GoObject, b: GoObject): boolean {
  return a === b;
}

export function arrayEq<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const ids = new Map<GoObject, number>();
export function objectId(o: GoObject): number {
  let id = ids.get(o);
  if (id === undefined) {
    id = ids.size + 1;
    ids.set(o, id);
  }
  return id;
}

export function strMin(xs: string[]): string {
  let m = xs[0];
  for (let i = 1; i < xs.length; i++) if (xs[i] < m) m = xs[i];
  return m;
}

export function strMax(xs: string[]): string {
  let m = xs[0];
  for (let i = 1; i < xs.length; i++) if (xs[i] > m) m = xs[i];
  return m;
}

// Integers. Go int is 64-bit; values here are exact up to 2^53.

const TWO32 = 4294967296;

export function imod(a: number, b: number): number {
  if (b === 0) throw new Panic(new Box<string>('integer divide by zero', 'string'));
  return a - Math.trunc(a / b) * b;
}

export function shl64(a: number, n: number): number {
  return n >= 64 ? 0 : a * Math.pow(2, n);
}

export function shr64(a: number, n: number): number {
  return n >= 64 ? (a < 0 ? -1 : 0) : Math.floor(a / Math.pow(2, n));
}

function hi(a: number): number {
  return Math.floor(a / TWO32) | 0;
}
function lo(a: number): number {
  return a >>> 0;
}
function join(h: number, l: number): number {
  return h * TWO32 + (l >>> 0);
}

export function and64(a: number, b: number): number {
  if ((a | 0) === a && (b | 0) === b) return a & b;
  return join(hi(a) & hi(b), lo(a) & lo(b));
}

export function or64(a: number, b: number): number {
  if ((a | 0) === a && (b | 0) === b) return a | b;
  return join(hi(a) | hi(b), lo(a) | lo(b));
}

export function xor64(a: number, b: number): number {
  if ((a | 0) === a && (b | 0) === b) return a ^ b;
  return join(hi(a) ^ hi(b), lo(a) ^ lo(b));
}

export function andNot64(a: number, b: number): number {
  return join(hi(a) & ~hi(b), lo(a) & ~lo(b));
}

// Byte strings.

export function runeToString(r: number): string {
  if (r < 0 || r > 0x10ffff || (r >= 0xd800 && r <= 0xdfff)) r = 0xfffd;
  if (r < 0x80) return String.fromCharCode(r);
  if (r < 0x800) return String.fromCharCode(0xc0 | (r >> 6), 0x80 | (r & 0x3f));
  if (r < 0x10000) return String.fromCharCode(0xe0 | (r >> 12), 0x80 | ((r >> 6) & 0x3f), 0x80 | (r & 0x3f));
  return String.fromCharCode(0xf0 | (r >> 18), 0x80 | ((r >> 12) & 0x3f), 0x80 | ((r >> 6) & 0x3f), 0x80 | (r & 0x3f));
}

export function bytesToString(b: number[]): string {
  let s = '';
  for (let i = 0; i < b.length; i += 4096) {
    const end = Math.min(b.length, i + 4096);
    const codes: number[] = [];
    for (let j = i; j < end; j++) codes.push(b[j] & 0xff);
    s += String.fromCharCode(...codes);
  }
  return s;
}

export function stringToBytes(s: string): number[] {
  const b: number[] = [];
  for (let i = 0; i < s.length; i++) b.push(s.charCodeAt(i));
  return b;
}

export function stringToRunes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length;) {
    const [r, n] = utf8_DecodeRuneInStringAt(s, i);
    out.push(r);
    i += n;
  }
  return out;
}

export function runesToString(rs: number[]): string {
  let s = '';
  for (let i = 0; i < rs.length; i++) s += runeToString(rs[i]);
  return s;
}

// utf8_DecodeRuneInStringAt decodes the rune at byte offset i, like
// utf8.DecodeRuneInString(s[i:]).
export function utf8_DecodeRuneInStringAt(s: string, i: number): [number, number] {
  const n = s.length - i;
  if (n < 1) return [0xfffd, 0];
  const c0 = s.charCodeAt(i);
  if (c0 < 0x80) return [c0, 1];
  if (c0 < 0xc2 || c0 > 0xf4) return [0xfffd, 1];
  if (c0 < 0xe0) {
    if (n < 2) return [0xfffd, 1];
    const c1 = s.charCodeAt(i + 1);
    if ((c1 & 0xc0) !== 0x80) return [0xfffd, 1];
    return [((c0 & 0x1f) << 6) | (c1 & 0x3f), 2];
  }
  if (c0 < 0xf0) {
    if (n < 3) return [0xfffd, 1];
    const c1 = s.charCodeAt(i + 1);
    const lo1 = c0 === 0xe0 ? 0xa0 : 0x80;
    const hi1 = c0 === 0xed ? 0x9f : 0xbf;
    if (c1 < lo1 || c1 > hi1) return [0xfffd, 1];
    const c2 = s.charCodeAt(i + 2);
    if ((c2 & 0xc0) !== 0x80) return [0xfffd, 1];
    return [((c0 & 0x0f) << 12) | ((c1 & 0x3f) << 6) | (c2 & 0x3f), 3];
  }
  if (n < 4) return [0xfffd, 1];
  const c1 = s.charCodeAt(i + 1);
  const lo1 = c0 === 0xf0 ? 0x90 : 0x80;
  const hi1 = c0 === 0xf4 ? 0x8f : 0xbf;
  if (c1 < lo1 || c1 > hi1) return [0xfffd, 1];
  const c2 = s.charCodeAt(i + 2);
  const c3 = s.charCodeAt(i + 3);
  if ((c2 & 0xc0) !== 0x80 || (c3 & 0xc0) !== 0x80) return [0xfffd, 1];
  return [((c0 & 0x07) << 18) | ((c1 & 0x3f) << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f), 4];
}

// Converts between byte strings and host strings at I/O boundaries.
export function fromHostString(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    out += c < 0x80 ? String.fromCharCode(c) : runeToString(c);
  }
  return out;
}

export function toHostString(s: string): string {
  let out = '';
  for (let i = 0; i < s.length;) {
    const [r, n] = utf8_DecodeRuneInStringAt(s, i);
    out +=
      r < 0x10000
        ? String.fromCharCode(r)
        : String.fromCharCode(0xd800 + ((r - 0x10000) >> 10), 0xdc00 + ((r - 0x10000) & 0x3ff));
    i += n;
  }
  return out;
}

export class Chan<T> extends GoObject {
  items: T[] = [];
}

// Stubbed library calls made while modules initialize return zero values;
// package variables built from them only fail if the program uses them.
let initializing = true;
export function initDone(): void {
  initializing = false;
}
export function stubCall<T>(what: string, zero: T): T {
  if (initializing) return zero;
  throw new Error('unsupported: ' + what);
}

// Non-generic type assertion helpers.
export function typeAssertError(): Panic {
  return new Panic(new BoxStr('interface conversion', 'string'));
}
export function checkNumber(ok: boolean, v: GoObject | undefined): number {
  if (ok && v instanceof BoxNum) return v.v;
  throw typeAssertError();
}
export function checkString(ok: boolean, v: GoObject | undefined): string {
  if (ok && v instanceof BoxStr) return v.v;
  throw typeAssertError();
}
export function checkBool(ok: boolean, v: GoObject | undefined): boolean {
  if (ok && v instanceof BoxBool) return v.v;
  throw typeAssertError();
}

// Generated modules construct every class behind keepClasses() so scriptc
// lowers each one; the branch never runs.
let keepFlag = false;
export function keepClasses(): boolean {
  return keepFlag;
}
export function kept(objects: GoObject[]): void {
  if (objects.length < 0) keepFlag = true;
}

export function unboxAny<T>(v: GoObject | undefined): T {
  if (v instanceof Box) return (v as Box<T>).v;
  return v as T;
}

// fromBytes converts file contents to a byte string.
export function fromBytes(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 4096) {
    const end = Math.min(bytes.length, i + 4096);
    const codes: number[] = [];
    for (let j = i; j < end; j++) codes.push(bytes[j]);
    parts.push(String.fromCharCode(...codes));
  }
  return parts.join('');
}

// Map.prototype.clear has no scriptc lowering; delete keys one by one.
export function clearMap<K, V>(m: Map<K, V> | undefined): void {
  if (m === undefined) return;
  const keys: K[] = [];
  for (const k of m.keys()) keys.push(k);
  for (const k of keys) m.delete(k);
}

// ptrTo makes a pointer to a variable, field or element.
export function ptrTo<T>(g: () => T, s: (v: T) => void): Ptr<T> {
  return new Ptr<T>(g(), g, s);
}

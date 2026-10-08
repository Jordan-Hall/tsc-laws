// Go standard library subset for translated code. Strings are byte strings.
import {
  GoObject,
  GoError,
  BoxNum,
  BoxStr,
  BoxBool,
  utf8_DecodeRuneInStringAt,
  runeToString,
  imod,
  bytesToString,
  objectId,
  StructMap,
  ifaceKey,
  Chan,
  Empty,
  toHostString,
  fromHostString,
} from './base.js';

// strings

export function strings_HasPrefix(s: string, p: string): boolean {
  return s.startsWith(p);
}
export function strings_HasSuffix(s: string, p: string): boolean {
  return s.endsWith(p);
}
export function strings_Contains(s: string, sub: string): boolean {
  return s.indexOf(sub) >= 0;
}
export function strings_ContainsRune(s: string, r: number): boolean {
  return s.indexOf(runeToString(r)) >= 0;
}
export function strings_ContainsAny(s: string, chars: string): boolean {
  return strings_IndexAny(s, chars) >= 0;
}
export function strings_Index(s: string, sub: string): number {
  return s.indexOf(sub);
}
export function strings_LastIndex(s: string, sub: string): number {
  return s.lastIndexOf(sub);
}
export function strings_IndexByte(s: string, c: number): number {
  return s.indexOf(String.fromCharCode(c));
}
export function strings_LastIndexByte(s: string, c: number): number {
  return s.lastIndexOf(String.fromCharCode(c));
}
export function strings_IndexRune(s: string, r: number): number {
  return s.indexOf(runeToString(r));
}
export function strings_IndexAny(s: string, chars: string): number {
  for (let i = 0; i < s.length;) {
    const [r, n] = utf8_DecodeRuneInStringAt(s, i);
    if (chars.indexOf(runeToString(r)) >= 0) return i;
    i += n;
  }
  return -1;
}
export function strings_IndexFunc(s: string, f: ((r: number) => boolean) | undefined): number {
  for (let i = 0; i < s.length;) {
    const [r, n] = utf8_DecodeRuneInStringAt(s, i);
    if (f!(r)) return i;
    i += n;
  }
  return -1;
}
export function strings_Count(s: string, sub: string): number {
  if (sub.length === 0) return utf8_RuneCountInString(s) + 1;
  let n = 0;
  for (let i = s.indexOf(sub); i >= 0; i = s.indexOf(sub, i + sub.length)) n++;
  return n;
}
export function strings_Compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
export function strings_EqualFold(a: string, b: string): boolean {
  return strings_ToLower(a) === strings_ToLower(b);
}
export function strings_Join(parts: string[], sep: string): string {
  return parts.join(sep);
}
export function strings_Split(s: string, sep: string): string[] {
  if (sep === '') {
    const out: string[] = [];
    for (let i = 0; i < s.length;) {
      const n = utf8_DecodeRuneInStringAt(s, i)[1];
      out.push(s.substring(i, i + n));
      i += n;
    }
    return out;
  }
  return s.split(sep);
}
export function strings_Repeat(s: string, n: number): string {
  return s.repeat(n);
}
export function strings_ReplaceAll(s: string, old: string, rep: string): string {
  return s.split(old).join(rep);
}
export function strings_Replace(s: string, old: string, rep: string, n: number): string {
  if (n < 0) return strings_ReplaceAll(s, old, rep);
  let out = s;
  let from = 0;
  for (let k = 0; k < n; k++) {
    const i = out.indexOf(old, from);
    if (i < 0) break;
    out = out.substring(0, i) + rep + out.substring(i + old.length);
    from = i + rep.length;
  }
  return out;
}
export function strings_TrimPrefix(s: string, p: string): string {
  return s.startsWith(p) ? s.substring(p.length) : s;
}
export function strings_TrimSuffix(s: string, p: string): string {
  return p.length > 0 && s.endsWith(p) ? s.substring(0, s.length - p.length) : s;
}
export function strings_CutPrefix(s: string, p: string): [string, boolean] {
  return s.startsWith(p) ? [s.substring(p.length), true] : [s, false];
}
export function strings_CutSuffix(s: string, p: string): [string, boolean] {
  return s.endsWith(p) ? [s.substring(0, s.length - p.length), true] : [s, false];
}
export function strings_Cut(s: string, sep: string): [string, string, boolean] {
  const i = s.indexOf(sep);
  return i >= 0 ? [s.substring(0, i), s.substring(i + sep.length), true] : [s, '', false];
}
function isSpaceByte(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13);
}
export function strings_TrimSpace(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isSpaceByte(s.charCodeAt(a))) a++;
  while (b > a && isSpaceByte(s.charCodeAt(b - 1))) b--;
  if (a < b && (s.charCodeAt(a) >= 0x80 || s.charCodeAt(b - 1) >= 0x80)) return strings_TrimFunc(s, unicode_IsSpace);
  return s.substring(a, b);
}
export function strings_TrimLeftFunc(s: string, f: ((r: number) => boolean) | undefined): string {
  let i = 0;
  while (i < s.length) {
    const [r, n] = utf8_DecodeRuneInStringAt(s, i);
    if (!f!(r)) break;
    i += n;
  }
  return s.substring(i);
}
export function strings_TrimRightFunc(s: string, f: ((r: number) => boolean) | undefined): string {
  let end = s.length;
  while (end > 0) {
    const [r, n] = utf8_DecodeLastRuneInString(s.substring(0, end));
    if (!f!(r)) break;
    end -= n;
  }
  return s.substring(0, end);
}
export function strings_TrimFunc(s: string, f: ((r: number) => boolean) | undefined): string {
  return strings_TrimRightFunc(strings_TrimLeftFunc(s, f), f);
}
export function strings_TrimLeft(s: string, cutset: string): string {
  return strings_TrimLeftFunc(s, (r: number): boolean => cutset.indexOf(runeToString(r)) >= 0);
}
export function strings_TrimRight(s: string, cutset: string): string {
  return strings_TrimRightFunc(s, (r: number): boolean => cutset.indexOf(runeToString(r)) >= 0);
}
export function strings_Trim(s: string, cutset: string): string {
  return strings_TrimRight(strings_TrimLeft(s, cutset), cutset);
}
export function strings_ToLower(s: string): string {
  let ascii = true;
  for (let i = 0; i < s.length; i++)
    if (s.charCodeAt(i) >= 0x80) {
      ascii = false;
      break;
    }
  if (ascii) return s.toLowerCase();
  return strings_Map((r: number): number => unicode_ToLower(r), s);
}
export function strings_ToUpper(s: string): string {
  let ascii = true;
  for (let i = 0; i < s.length; i++)
    if (s.charCodeAt(i) >= 0x80) {
      ascii = false;
      break;
    }
  if (ascii) return s.toUpperCase();
  return strings_Map((r: number): number => unicode_ToUpper(r), s);
}
export function strings_Map(f: ((r: number) => number) | undefined, s: string): string {
  let out = '';
  for (let i = 0; i < s.length;) {
    const [r, n] = utf8_DecodeRuneInStringAt(s, i);
    const m = f!(r);
    if (m >= 0) out += runeToString(m);
    i += n;
  }
  return out;
}
export function strings_Fields(s: string): string[] {
  const out: string[] = [];
  let start = -1;
  for (let i = 0; i <= s.length; i++) {
    const sp = i === s.length || isSpaceByte(s.charCodeAt(i));
    if (sp && start >= 0) {
      out.push(s.substring(start, i));
      start = -1;
    } else if (!sp && start < 0) start = i;
  }
  return out;
}
export function strings_ToValidUTF8(s: string, rep: string): string {
  let out = '';
  let invalid = false;
  for (let i = 0; i < s.length;) {
    const [r, n] = utf8_DecodeRuneInStringAt(s, i);
    if (r === 0xfffd && n === 1) {
      if (!invalid) out += rep;
      invalid = true;
    } else {
      out += s.substring(i, i + n);
      invalid = false;
    }
    i += n;
  }
  return out;
}

export class strings_Builder extends GoObject {
  parts: string[] = [];
  n = 0;
  WriteString(s: string): [number, GoObject | undefined] {
    this.parts.push(s);
    this.n += s.length;
    return [s.length, undefined];
  }
  WriteByte(c: number): GoObject | undefined {
    this.parts.push(String.fromCharCode(c));
    this.n++;
    return undefined;
  }
  WriteRune(r: number): [number, GoObject | undefined] {
    const s = runeToString(r);
    this.parts.push(s);
    this.n += s.length;
    return [s.length, undefined];
  }
  Write(b: number[]): [number, GoObject | undefined] {
    for (const c of b) this.WriteByte(c);
    return [b.length, undefined];
  }
  override String(): string {
    if (this.parts.length > 1) this.parts = [this.parts.join('')];
    return this.parts.length === 0 ? '' : this.parts[0];
  }
  Len(): number {
    return this.n;
  }
  Reset(): void {
    this.parts = [];
    this.n = 0;
  }
  Grow(_n: number): void {}
  $clone(): strings_Builder {
    const b = new strings_Builder();
    b.parts = this.parts.slice();
    b.n = this.n;
    return b;
  }
}

// unicode/utf8 and unicode/utf16

export function unicode_utf8_DecodeRuneInString(s: string): [number, number] {
  return utf8_DecodeRuneInStringAt(s, 0);
}
export function utf8_DecodeLastRuneInString(s: string): [number, number] {
  const end = s.length;
  if (end === 0) return [0xfffd, 0];
  if (s.charCodeAt(end - 1) < 0x80) return [s.charCodeAt(end - 1), 1];
  const lim = Math.max(0, end - 4);
  let start = end - 1;
  while (start > lim && (s.charCodeAt(start) & 0xc0) === 0x80) start--;
  const [r, n] = utf8_DecodeRuneInStringAt(s, start);
  if (start + n !== end) return [0xfffd, 1];
  return [r, n];
}
export const unicode_utf8_DecodeLastRuneInString = utf8_DecodeLastRuneInString;
export function utf8_RuneCountInString(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; n++) i += utf8_DecodeRuneInStringAt(s, i)[1];
  return n;
}
export const unicode_utf8_RuneCountInString = utf8_RuneCountInString;
export function unicode_utf8_RuneLen(r: number): number {
  if (r < 0) return -1;
  if (r < 0x80) return 1;
  if (r < 0x800) return 2;
  if (r >= 0xd800 && r <= 0xdfff) return -1;
  if (r < 0x10000) return 3;
  if (r <= 0x10ffff) return 4;
  return -1;
}
export function unicode_utf8_ValidString(s: string): boolean {
  for (let i = 0; i < s.length;) {
    const [r, n] = utf8_DecodeRuneInStringAt(s, i);
    if (r === 0xfffd && n === 1) return false;
    i += n;
  }
  return true;
}
export function unicode_utf8_EncodeRune(p: number[], r: number): number {
  const s = runeToString(r);
  for (let i = 0; i < s.length; i++) p[i] = s.charCodeAt(i);
  return s.length;
}
export function unicode_utf8_AppendRune(p: number[], r: number): number[] {
  const s = runeToString(r);
  const out = p.slice();
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  return out;
}
export const unicode_utf8_RuneError = 0xfffd;
export function unicode_utf16_IsSurrogate(r: number): boolean {
  return r >= 0xd800 && r < 0xe000;
}
export function unicode_utf16_RuneLen(r: number): number {
  if ((r >= 0 && r < 0xd800) || (r >= 0xe000 && r < 0x10000)) return 1;
  if (r >= 0x10000 && r <= 0x10ffff) return 2;
  return -1;
}
export function unicode_utf16_EncodeRune(r: number): [number, number] {
  if (r < 0x10000 || r > 0x10ffff) return [0xfffd, 0xfffd];
  const v = r - 0x10000;
  return [0xd800 + ((v >> 10) & 0x3ff), 0xdc00 + (v & 0x3ff)];
}
export function unicode_utf16_DecodeRune(a: number, b: number): number {
  if (a >= 0xd800 && a < 0xdc00 && b >= 0xdc00 && b < 0xe000) return (((a - 0xd800) << 10) | (b - 0xdc00)) + 0x10000;
  return 0xfffd;
}

// unicode

export class unicode_Range16 extends GoObject {
  Lo: number;
  Hi: number;
  Stride: number;
  constructor(lo = 0, hi = 0, stride = 0) {
    super();
    this.Lo = lo;
    this.Hi = hi;
    this.Stride = stride;
  }
}
export class unicode_Range32 extends GoObject {
  Lo: number;
  Hi: number;
  Stride: number;
  constructor(lo = 0, hi = 0, stride = 0) {
    super();
    this.Lo = lo;
    this.Hi = hi;
    this.Stride = stride;
  }
}
export class unicode_RangeTable extends GoObject {
  R16: unicode_Range16[];
  R32: unicode_Range32[];
  LatinOffset: number;
  constructor(r16: unicode_Range16[] = [], r32: unicode_Range32[] = [], latinOffset = 0) {
    super();
    this.R16 = r16;
    this.R32 = r32;
    this.LatinOffset = latinOffset;
  }
}
function inRanges(ranges: (unicode_Range16 | unicode_Range32)[], r: number): boolean {
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const m = lo + ((hi - lo) >> 1);
    const g = ranges[m];
    if (g.Lo <= r && r <= g.Hi) return g.Stride === 1 || imod(r - g.Lo, g.Stride) === 0;
    if (r < g.Lo) hi = m;
    else lo = m + 1;
  }
  return false;
}
export function unicode_Is(t: unicode_RangeTable | undefined, r: number): boolean {
  if (t!.R16.length > 0 && r <= t!.R16[t!.R16.length - 1].Hi) return inRanges(t!.R16, r);
  if (t!.R32.length > 0 && r >= t!.R32[0].Lo) return inRanges(t!.R32, r);
  return false;
}
export function unicode_In(r: number, tables: (unicode_RangeTable | undefined)[]): boolean {
  for (const t of tables) if (unicode_Is(t, r)) return true;
  return false;
}
export const unicode_Zs = new unicode_RangeTable(
  [
    new unicode_Range16(0x0020, 0x0020, 1),
    new unicode_Range16(0x00a0, 0x00a0, 1),
    new unicode_Range16(0x1680, 0x1680, 1),
    new unicode_Range16(0x2000, 0x200a, 1),
    new unicode_Range16(0x202f, 0x202f, 1),
    new unicode_Range16(0x205f, 0x205f, 1),
    new unicode_Range16(0x3000, 0x3000, 1),
  ],
  [],
  2,
);
export function unicode_IsSpace(r: number): boolean {
  if (r <= 0xff) return r === 32 || (r >= 9 && r <= 13) || r === 0x85 || r === 0xa0;
  return unicode_Is(unicode_Zs, r) || r === 0x2028 || r === 0x2029;
}
export function unicode_IsDigit(r: number): boolean {
  return r >= 48 && r <= 57;
}
export function unicode_IsUpper(r: number): boolean {
  return unicode_ToLower(r) !== r;
}
export function unicode_IsLower(r: number): boolean {
  return unicode_ToUpper(r) !== r;
}
export function unicode_IsLetter(r: number): boolean {
  if (r < 0x80) return (r >= 65 && r <= 90) || (r >= 97 && r <= 122);
  return unicode_ToLower(r) !== r || unicode_ToUpper(r) !== r;
}
// Simple case mapping through the host for code points outside ASCII.
export function unicode_ToLower(r: number): number {
  if (r < 0x80) return r >= 65 && r <= 90 ? r + 32 : r;
  return simpleMap(r, String.fromCodePoint(r).toLowerCase());
}
export function unicode_ToUpper(r: number): number {
  if (r < 0x80) return r >= 97 && r <= 122 ? r - 32 : r;
  return simpleMap(r, String.fromCodePoint(r).toUpperCase());
}
function simpleMap(r: number, mapped: string): number {
  const c = mapped.codePointAt(0);
  if (c === undefined) return r;
  return mapped.length === (c > 0xffff ? 2 : 1) ? c : r;
}

// strconv

export function strconv_Itoa(n: number): string {
  return String(n);
}
export function strconv_FormatInt(n: number, base: number): string {
  return n.toString(base);
}
export function strconv_FormatUint(n: number, base: number): string {
  return n.toString(base);
}
export function strconv_FormatFloat(f: number, _fmt: number, _prec: number, _bits: number): string {
  return String(f);
}
export const strconv_ErrRange: GoObject | undefined = new GoError('value out of range');
export const strconv_ErrSyntax: GoObject | undefined = new GoError('invalid syntax');
export function strconv_ParseInt(s: string, base: number, _bits: number): [number, GoObject | undefined] {
  let t = s;
  let b = base;
  let neg = false;
  if (t.startsWith('-') || t.startsWith('+')) {
    neg = t[0] === '-';
    t = t.substring(1);
  }
  if (b === 0) {
    b = 10;
    if (t.startsWith('0x') || t.startsWith('0X')) {
      b = 16;
      t = t.substring(2);
    } else if (t.startsWith('0b') || t.startsWith('0B')) {
      b = 2;
      t = t.substring(2);
    } else if (t.startsWith('0o') || t.startsWith('0O')) {
      b = 8;
      t = t.substring(2);
    } else if (t.length > 1 && t[0] === '0') {
      b = 8;
      t = t.substring(1);
    }
    t = t.split('_').join('');
  }
  if (t.length === 0) return [0, strconv_ErrSyntax];
  let v = 0;
  for (let i = 0; i < t.length; i++) {
    const d = digitVal(t.charCodeAt(i));
    if (d >= b) return [0, strconv_ErrSyntax];
    v = v * b + d;
  }
  return [neg ? -v : v, undefined];
}
function digitVal(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 122) return c - 87;
  if (c >= 65 && c <= 90) return c - 55;
  return 99;
}
export function strconv_ParseUint(s: string, base: number, bits: number): [number, GoObject | undefined] {
  if (s.startsWith('-') || s.startsWith('+')) return [0, strconv_ErrSyntax];
  return strconv_ParseInt(s, base, bits);
}
export function strconv_Atoi(s: string): [number, GoObject | undefined] {
  return strconv_ParseInt(s, 10, 64);
}
export function strconv_ParseFloat(s: string, _bits: number): [number, GoObject | undefined] {
  const v = Number(s);
  if (Number.isNaN(v) && s !== 'NaN') return [0, strconv_ErrSyntax];
  return [v, undefined];
}
export function strconv_Quote(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length;) {
    const [r, n] = utf8_DecodeRuneInStringAt(s, i);
    if (r === 34) out += '\\"';
    else if (r === 92) out += '\\\\';
    else if (r === 10) out += '\\n';
    else if (r === 13) out += '\\r';
    else if (r === 9) out += '\\t';
    else if (r === 0xfffd && n === 1) out += '\\x' + s.charCodeAt(i).toString(16).padStart(2, '0');
    else if (r < 32 || r === 127) out += '\\x' + r.toString(16).padStart(2, '0');
    else out += s.substring(i, i + n);
    i += n;
  }
  return out + '"';
}

// math

export function math_NaN(): number {
  return NaN;
}
export function math_Inf(sign: number): number {
  return sign >= 0 ? Infinity : -Infinity;
}
export function math_IsNaN(f: number): boolean {
  return Number.isNaN(f);
}
export function math_IsInf(f: number, sign: number): boolean {
  return sign > 0 ? f === Infinity : sign < 0 ? f === -Infinity : !Number.isFinite(f) && !Number.isNaN(f);
}
export function math_Trunc(f: number): number {
  return Math.trunc(f);
}
export function math_Floor(f: number): number {
  return Math.floor(f);
}
export function math_Ceil(f: number): number {
  return Math.ceil(f);
}
export function math_Abs(f: number): number {
  return Math.abs(f);
}
export function math_Min(a: number, b: number): number {
  return Math.min(a, b);
}
export function math_Max(a: number, b: number): number {
  return Math.max(a, b);
}
export function math_Pow(a: number, b: number): number {
  return Math.pow(a, b);
}
export function math_Mod(a: number, b: number): number {
  return a % b;
}
export function math_Sqrt(f: number): number {
  return Math.sqrt(f);
}
export function math_Log(f: number): number {
  return Math.log(f);
}
export function math_Log10(f: number): number {
  return Math.log10(f);
}
export function math_Round(f: number): number {
  return f < 0 ? -Math.round(-f) : Math.round(f);
}
export function math_Log2(f: number): number {
  return Math.log2(f);
}
export function math_Copysign(f: number, sign: number): number {
  const neg = sign < 0 || (sign === 0 && 1 / sign < 0);
  return neg ? -Math.abs(f) : Math.abs(f);
}
export function math_Signbit(f: number): boolean {
  return f < 0 || (f === 0 && 1 / f < 0);
}
export const math_MaxInt32 = 2147483647;
export const math_MinInt32 = -2147483648;

// cmp, sort, slices, maps

export function cmp_Compare<T>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
export function sort_Search(n: number, f: ((i: number) => boolean) | undefined): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const m = lo + ((hi - lo) >> 1);
    if (!f!(m)) lo = m + 1;
    else hi = m;
  }
  return lo;
}
export function slices_Clone<T>(s: T[]): T[] {
  return s.slice();
}
export function slices_Contains<T>(s: T[], v: T): boolean {
  return s.indexOf(v) >= 0;
}
export function slices_IndexEq<T>(s: T[], v: T, eq: (a: T, b: T) => boolean): number {
  for (let i = 0; i < s.length; i++) if (eq(s[i], v)) return i;
  return -1;
}
export function slices_ContainsFunc<T>(s: T[], f: ((v: T) => boolean) | undefined): boolean {
  for (const v of s) if (f!(v)) return true;
  return false;
}
export function slices_Index<T>(s: T[], v: T): number {
  return s.indexOf(v);
}
export function slices_IndexFunc<T>(s: T[], f: ((v: T) => boolean) | undefined): number {
  for (let i = 0; i < s.length; i++) if (f!(s[i])) return i;
  return -1;
}
export function slices_Equal<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
export function slices_EqualFunc<T, U>(a: T[], b: U[], eq: ((x: T, y: U) => boolean) | undefined): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!eq!(a[i], b[i])) return false;
  return true;
}
export function slices_Compare<T>(a: T[], b: T[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = cmp_Compare(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length < 0 ? -1 : a.length > b.length ? 1 : 0;
}
// Stable merge sort, matching Go's results for SortStableFunc and giving a
// deterministic order for SortFunc.
function mergeSort<T>(s: T[], cmp: (a: T, b: T) => number): void {
  if (s.length < 2) return;
  const tmp = s.slice();
  sortRange(s, tmp, 0, s.length, cmp);
}
function sortRange<T>(a: T[], tmp: T[], lo: number, hi: number, cmp: (a: T, b: T) => number): void {
  if (hi - lo <= 12) {
    for (let i = lo + 1; i < hi; i++) {
      const v = a[i];
      let j = i - 1;
      while (j >= lo && cmp(a[j], v) > 0) {
        a[j + 1] = a[j];
        j--;
      }
      a[j + 1] = v;
    }
    return;
  }
  const mid = lo + ((hi - lo) >> 1);
  sortRange(a, tmp, lo, mid, cmp);
  sortRange(a, tmp, mid, hi, cmp);
  if (cmp(a[mid - 1], a[mid]) <= 0) return;
  for (let i = lo; i < hi; i++) tmp[i] = a[i];
  let i = lo;
  let j = mid;
  for (let k = lo; k < hi; k++) {
    if (j >= hi || (i < mid && cmp(tmp[i], tmp[j]) <= 0)) a[k] = tmp[i++];
    else a[k] = tmp[j++];
  }
}
export function slices_SortFunc<T>(s: T[], cmp: ((a: T, b: T) => number) | undefined): void {
  mergeSort(s, cmp!);
}
export function slices_SortStableFunc<T>(s: T[], cmp: ((a: T, b: T) => number) | undefined): void {
  mergeSort(s, cmp!);
}
export function slices_Sort<T>(s: T[]): void {
  mergeSort(s, cmp_Compare);
}
export function slices_BinarySearch<T>(s: T[], v: T): [number, boolean] {
  const i = sort_Search(s.length, (k: number): boolean => cmp_Compare(s[k], v) >= 0);
  return [i, i < s.length && s[i] === v];
}
export function slices_BinarySearchFunc<T, U>(
  s: T[],
  v: U,
  cmp: ((a: T, b: U) => number) | undefined,
): [number, boolean] {
  const i = sort_Search(s.length, (k: number): boolean => cmp!(s[k], v) >= 0);
  return [i, i < s.length && cmp!(s[i], v) === 0];
}
export function slices_Insert<T>(s: T[], i: number, vs: T[]): T[] {
  const out = s.slice();
  out.splice(i, 0, ...vs);
  return out;
}
export function slices_Delete<T>(s: T[], i: number, j: number): T[] {
  const out = s.slice();
  out.splice(i, j - i);
  return out;
}
export function slices_Grow<T>(s: T[], _n: number): T[] {
  return s;
}
export function slices_Clip<T>(s: T[]): T[] {
  return s;
}
export function slices_Concat<T>(parts: T[][]): T[] {
  const out: T[] = [];
  for (const p of parts) for (const v of p) out.push(v);
  return out;
}
export function slices_Reverse<T>(s: T[]): void {
  s.reverse();
}
export function slices_Max<T>(s: T[]): T {
  let m = s[0];
  for (const v of s) if (v > m) m = v;
  return m;
}
export function slices_Min<T>(s: T[]): T {
  let m = s[0];
  for (const v of s) if (v < m) m = v;
  return m;
}
// iter.Seq and iter.Seq2 as translated code types them.
export type Seq<T> = ((yield_: ((v: T) => boolean) | undefined) => void) | undefined;
export type Seq2<K, V> = ((yield_: ((k: K, v: V) => boolean) | undefined) => void) | undefined;

export function slices_AppendSeq<T>(s: T[], seq: Seq<T>): T[] {
  const out = s.slice();
  seq!((v: T): boolean => {
    out.push(v);
    return true;
  });
  return out;
}
export function slices_Collect<T>(seq: Seq<T>): T[] {
  return slices_AppendSeq<T>([], seq);
}
export function slices_Values<T>(s: T[]): Seq<T> {
  return (y: ((v: T) => boolean) | undefined): void => {
    for (const v of s) if (!y!(v)) return;
  };
}
export function maps_Keys<K, V>(m: Map<K, V> | undefined): Seq<K> {
  return (y: ((k: K) => boolean) | undefined): void => {
    if (m !== undefined) for (const k of m.keys()) if (!y!(k)) return;
  };
}
export function maps_Values<K, V>(m: Map<K, V> | undefined): Seq<V> {
  return (y: ((v: V) => boolean) | undefined): void => {
    if (m !== undefined) for (const v of m.values()) if (!y!(v)) return;
  };
}

// unsafe conversions between byte slices and strings.
export function unsafe_SliceData(b: number[]): number[] {
  return b;
}
export function unsafe_StringData(s: string): string {
  return s;
}
export function unsafe_String(b: number[], n: number): string {
  return bytesToString(b.length === n ? b : b.slice(0, n));
}
export function maps_Clone<K, V>(m: Map<K, V> | undefined): Map<K, V> | undefined {
  return m === undefined ? undefined : new Map<K, V>(m);
}
export function maps_Copy<K, V>(dst: Map<K, V> | undefined, src: Map<K, V> | undefined): void {
  if (src !== undefined) for (const [k, v] of src) dst!.set(k, v);
}
export function maps_Equal<K, V>(a: Map<K, V> | undefined, b: Map<K, V> | undefined): boolean {
  const n = a === undefined ? 0 : a.size;
  if (n !== (b === undefined ? 0 : b.size)) return false;
  if (a !== undefined) for (const [k, v] of a) if (!b!.has(k) || b!.get(k) !== v) return false;
  return true;
}

// errors, fmt

export function errors_New(msg: string): GoObject | undefined {
  return new GoError(msg);
}
export function errors_Is(err: GoObject | undefined, target: GoObject | undefined): boolean {
  return err === target;
}

function formatValue(v: GoObject | undefined, verb: string): string {
  if (v === undefined) return '<nil>';
  if (v instanceof BoxStr) return verb === 'q' ? strconv_Quote(v.v) : v.v;
  if (v instanceof BoxNum) {
    if (verb === 'x') return v.v.toString(16);
    if (verb === 'X') return v.v.toString(16).toUpperCase();
    if (verb === 'c') return runeToString(v.v);
    if (verb === 'q') return "'" + runeToString(v.v) + "'";
    return String(v.v);
  }
  if (v instanceof BoxBool) return v.v ? 'true' : 'false';
  if (v instanceof GoError) return v.msg;
  return v.String();
}

export function fmt_Sprintf(format: string, args: (GoObject | undefined)[]): string {
  let out = '';
  let ai = 0;
  for (let i = 0; i < format.length; i++) {
    const c = format[i];
    if (c !== '%') {
      out += c;
      continue;
    }
    i++;
    let flags = '';
    while (i < format.length && '+-# 0123456789.'.indexOf(format[i]) >= 0) flags += format[i++];
    const verb = format[i];
    if (verb === '%') {
      out += '%';
      continue;
    }
    let s = formatValue(args[ai++], verb);
    const width = parseInt(flags.replace(/[^0-9]/g, ''), 10);
    if (!Number.isNaN(width) && s.length < width)
      s = flags.startsWith('-') ? s.padEnd(width) : s.padStart(width, flags.startsWith('0') ? '0' : ' ');
    out += s;
  }
  return out;
}
export function fmt_Sprint(args: (GoObject | undefined)[]): string {
  return args.map((a) => formatValue(a, 'v')).join('');
}
export function fmt_Sprintln(args: (GoObject | undefined)[]): string {
  return args.map((a) => formatValue(a, 'v')).join(' ') + '\n';
}
export function fmt_Errorf(format: string, args: (GoObject | undefined)[]): GoObject | undefined {
  return new GoError(fmt_Sprintf(format, args));
}

// sync and sync/atomic run single-threaded. Methods that take no arguments
// return a value: scriptc calls zero-argument void methods through a dynamic
// property lookup.

export class sync_Mutex extends GoObject {
  Lock(): number {
    return 0;
  }
  Unlock(): number {
    return 0;
  }
  TryLock(): boolean {
    return true;
  }
  $clone(): sync_Mutex {
    return new sync_Mutex();
  }
}
export class sync_RWMutex extends GoObject {
  Lock(): number {
    return 0;
  }
  Unlock(): number {
    return 0;
  }
  RLock(): number {
    return 0;
  }
  RUnlock(): number {
    return 0;
  }
  $clone(): sync_RWMutex {
    return new sync_RWMutex();
  }
}
export class sync_Once extends GoObject {
  done = false;
  Do(f: (() => void) | undefined): void {
    if (!this.done) {
      this.done = true;
      f!();
    }
  }
  $clone(): sync_Once {
    const o = new sync_Once();
    o.done = this.done;
    return o;
  }
}
export class sync_WaitGroup extends GoObject {
  Add(_n: number): void {}
  Done(): number {
    return 0;
  }
  Wait(): number {
    return 0;
  }
  Go(f: (() => void) | undefined): void {
    f!();
  }
  $clone(): sync_WaitGroup {
    return new sync_WaitGroup();
  }
}
export function sync_OnceValue<T>(f: (() => T) | undefined): (() => T) | undefined {
  const cache: T[] = [];
  return (): T => {
    if (cache.length === 0) cache.push(f!());
    return cache[0];
  };
}
export function sync_OnceFunc(f: (() => void) | undefined): (() => void) | undefined {
  let done = false;
  return (): void => {
    if (!done) {
      done = true;
      f!();
    }
  };
}
export class sync_atomic_Uint64 extends GoObject {
  v = 0;
  Load(): number {
    return this.v;
  }
  Store(v: number): void {
    this.v = v;
  }
  Add(d: number): number {
    this.v += d;
    return this.v;
  }
  CompareAndSwap(old: number, nw: number): boolean {
    if (this.v !== old) return false;
    this.v = nw;
    return true;
  }
  $clone(): sync_atomic_Uint64 {
    const o = new sync_atomic_Uint64();
    o.v = this.v;
    return o;
  }
}
export class sync_atomic_Uint32 extends sync_atomic_Uint64 {}
export class sync_atomic_Int64 extends sync_atomic_Uint64 {}
export class sync_atomic_Int32 extends sync_atomic_Uint64 {}
export class sync_atomic_Bool extends GoObject {
  v = false;
  Load(): boolean {
    return this.v;
  }
  Store(v: boolean): void {
    this.v = v;
  }
  CompareAndSwap(old: boolean, nw: boolean): boolean {
    if (this.v !== old) return false;
    this.v = nw;
    return true;
  }
  $clone(): sync_atomic_Bool {
    const o = new sync_atomic_Bool();
    o.v = this.v;
    return o;
  }
}

// Replacement for TypeScript-Go's core.Arena, which relies on slice capacity.
export class core_Arena<T> extends GoObject {
  z: () => T;
  constructor(z: () => T) {
    super();
    this.z = z;
  }
  New(): T {
    return this.z();
  }
  NewSlice(size: number): T[] {
    const out: T[] = [];
    for (let i = 0; i < size; i++) out.push(this.z());
    return out;
  }
  NewSlice1(t: T): T[] {
    return [t];
  }
  Clone(t: T[]): T[] {
    return t.slice();
  }
  $clone(): core_Arena<T> {
    return new core_Arena<T>(this.z);
  }
}

export class sync_Pool extends GoObject {
  New: (() => GoObject | undefined) | undefined;
  items: (GoObject | undefined)[] = [];
  constructor(newFn: (() => GoObject | undefined) | undefined = undefined) {
    super();
    this.New = newFn;
  }
  Get(): GoObject | undefined {
    if (this.items.length > 0) return this.items.pop();
    return this.New === undefined ? undefined : this.New();
  }
  Put(x: GoObject | undefined): void {
    this.items.push(x);
  }
  $clone(): sync_Pool {
    return new sync_Pool(this.New);
  }
}

// strings.Index(s[from:], sub) without copying the suffix.
export function strings_IndexFrom(s: string, from: number, sub: string): number {
  const i = s.indexOf(sub, from);
  return i < 0 ? -1 : i - from;
}
export function strings_IndexByteFrom(s: string, from: number, c: number): number {
  const i = s.indexOf(String.fromCharCode(c), from);
  return i < 0 ? -1 : i - from;
}

// json.Marshal for basic values. Go encodes float64 with ECMAScript number
// formatting, which String() also produces.
export function github_com_go_json_experiment_json_Marshal(
  v: GoObject | undefined,
  _opts: (GoObject | undefined)[],
): [number[], GoObject | undefined] {
  let s: string;
  if (v instanceof BoxNum) s = Number.isFinite(v.v) ? String(v.v) : 'null';
  else if (v instanceof BoxStr) s = strconv_Quote(v.v);
  else if (v instanceof BoxBool) s = v.v ? 'true' : 'false';
  else if (v === undefined) s = 'null';
  else return [[], new GoError('json: unsupported value')];
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  return [out, undefined];
}

// sync.Map. Keys compare like Go interface values: boxed basic values by
// value, objects by identity.
function anyKey(k: GoObject | undefined): string {
  if (k === undefined) return 'nil';
  if (k instanceof BoxNum) return 'n' + k.t + ':' + String(k.v);
  if (k instanceof BoxStr) return 's' + k.t + ':' + k.v;
  if (k instanceof BoxBool) return 'b' + k.t + ':' + (k.v ? '1' : '0');
  return 'o' + String(objectId(k));
}
export class sync_Map extends GoObject {
  keys = new Map<string, GoObject | undefined>();
  vals = new Map<string, GoObject | undefined>();
  Load(k: GoObject | undefined): [GoObject | undefined, boolean] {
    const key = anyKey(k);
    return this.vals.has(key) ? [this.vals.get(key), true] : [undefined, false];
  }
  Store(k: GoObject | undefined, v: GoObject | undefined): void {
    const key = anyKey(k);
    this.keys.set(key, k);
    this.vals.set(key, v);
  }
  LoadOrStore(k: GoObject | undefined, v: GoObject | undefined): [GoObject | undefined, boolean] {
    const key = anyKey(k);
    if (this.vals.has(key)) return [this.vals.get(key), true];
    this.keys.set(key, k);
    this.vals.set(key, v);
    return [v, false];
  }
  LoadAndDelete(k: GoObject | undefined): [GoObject | undefined, boolean] {
    const r = this.Load(k);
    this.Delete(k);
    return r;
  }
  Delete(k: GoObject | undefined): void {
    const key = anyKey(k);
    this.keys.delete(key);
    this.vals.delete(key);
  }
  Swap(k: GoObject | undefined, v: GoObject | undefined): [GoObject | undefined, boolean] {
    const r = this.Load(k);
    this.Store(k, v);
    return r;
  }
  CompareAndSwap(k: GoObject | undefined, old: GoObject | undefined, v: GoObject | undefined): boolean {
    const [cur, ok] = this.Load(k);
    if (!ok || cur !== old) return false;
    this.Store(k, v);
    return true;
  }
  CompareAndDelete(k: GoObject | undefined, old: GoObject | undefined): boolean {
    const [cur, ok] = this.Load(k);
    if (!ok || cur !== old) return false;
    this.Delete(k);
    return true;
  }
  Range(f: ((k: GoObject | undefined, v: GoObject | undefined) => boolean) | undefined): void {
    for (const [key, k] of this.keys) if (!f!(k, this.vals.get(key))) return;
  }
  Clear(): void {
    this.keys = new Map<string, GoObject | undefined>();
    this.vals = new Map<string, GoObject | undefined>();
  }
  $clone(): sync_Map {
    return this;
  }
}

// golang.org/x/text/language: tags compare by their string form. The matcher
// never matches, so diagnostics use the built-in English messages.
export class golang_org_x_text_language_Tag extends GoObject {
  s: string;
  constructor(s = '') {
    super();
    this.s = s;
  }
  override String(): string {
    return this.s === '' ? 'und' : this.s;
  }
  $equals(o: golang_org_x_text_language_Tag): boolean {
    return this.s === o.s;
  }
  $clone(): golang_org_x_text_language_Tag {
    return this;
  }
}
export const golang_org_x_text_language_Und = new golang_org_x_text_language_Tag('');
export const golang_org_x_text_language_English = new golang_org_x_text_language_Tag('en');
export function golang_org_x_text_language_MustParse(s: string): golang_org_x_text_language_Tag {
  return new golang_org_x_text_language_Tag(s);
}
export function golang_org_x_text_language_Parse(s: string): [golang_org_x_text_language_Tag, GoObject | undefined] {
  return [new golang_org_x_text_language_Tag(s), undefined];
}
export class golang_org_x_text_language_Matcher extends GoObject {
  Match(_tags: golang_org_x_text_language_Tag[]): [golang_org_x_text_language_Tag, number, number] {
    return [golang_org_x_text_language_Und, -1, 0];
  }
}
export class golang_org_x_text_language_matcher extends golang_org_x_text_language_Matcher {}
export function golang_org_x_text_language_NewMatcher(
  _tags: golang_org_x_text_language_Tag[],
  _opts: (((m: golang_org_x_text_language_matcher | undefined) => void) | undefined)[],
): golang_org_x_text_language_Matcher | undefined {
  return new golang_org_x_text_language_Matcher();
}

// regexp on top of RegExp. Go strings here are UTF-8 byte strings, so
// matching runs on host strings and results are converted back.
function toRegExpSource(pattern: string): string {
  const src = toHostString(pattern).replace(/\\x\{([0-9A-Fa-f]+)\}/g, '\\u{$1}');
  // RE2 treats braces that do not form a quantifier as literals.
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      out += src.substring(i, i + 2);
      i++;
      if (src[i] === 'u' && src[i + 1] === '{') {
        const close = src.indexOf('}', i);
        out += src.substring(i + 1, close + 1);
        i = close;
      }
      continue;
    }
    if (c === '{') {
      const m = /^\{\d+(,\d*)?\}/.exec(src.substring(i));
      if (m !== null) {
        out += m[0];
        i += m[0].length - 1;
        continue;
      }
      out += '\\{';
      continue;
    }
    out += c === '}' ? '\\}' : c;
  }
  return out;
}
// Expands $1 and ${1} in a replacement template.
function expandTemplate(r: string, m: string[]): string {
  let out = '';
  for (let i = 0; i < r.length; i++) {
    if (r[i] !== '$' || i + 1 >= r.length) {
      out += r[i];
      continue;
    }
    let j = i + 1;
    const braced = r[j] === '{';
    if (braced) j++;
    let d = '';
    while (j < r.length && r[j] >= '0' && r[j] <= '9') d += r[j++];
    if (d === '' || (braced && r[j] !== '}')) {
      out += r[i];
      continue;
    }
    const g = m[Number(d)];
    out += g === undefined ? '' : g;
    i = braced ? j : j - 1;
  }
  return out;
}
export class regexp_Regexp extends GoObject {
  re: RegExp;
  src: string;
  constructor(src = '') {
    super();
    this.src = src;
    // Leading (?flags) groups become RegExp flags.
    let pattern = toRegExpSource(src);
    let flags = 'gu';
    const m = /^\(\?([imsU]+)\)/.exec(pattern);
    if (m !== null) {
      pattern = pattern.substring(m[0].length);
      for (const f of m[1]) if (f !== 'U' && flags.indexOf(f) < 0) flags += f;
    }
    this.re = new RegExp(pattern, flags);
  }
  MatchString(s: string): boolean {
    this.re.lastIndex = 0;
    return this.re.test(toHostString(s));
  }
  // Calls f for each match of re in host string h and joins the pieces.
  private replaceAll(h: string, f: (m: string[]) => string): string {
    let out = '';
    let last = 0;
    this.re.lastIndex = 0;
    for (let m = this.re.exec(h); m !== null; m = this.re.exec(h)) {
      out += h.substring(last, m.index) + f(m);
      last = m.index + m[0].length;
      if (m[0].length === 0) this.re.lastIndex = this.re.lastIndex + 1;
    }
    return out + h.substring(last);
  }
  ReplaceAllString(s: string, repl: string): string {
    const r = toHostString(repl);
    return fromHostString(this.replaceAll(toHostString(s), (m: string[]): string => expandTemplate(r, m)));
  }
  FindStringSubmatch(s: string): string[] {
    return regexp_Regexp_FindStringSubmatch(this, s);
  }
  Split(s: string, n: number): string[] {
    if (n === 0) return [];
    const h = toHostString(s);
    const out: string[] = [];
    let last = 0;
    this.re.lastIndex = 0;
    for (let m = this.re.exec(h); m !== null && (n < 0 || out.length < n - 1); m = this.re.exec(h)) {
      if (m[0].length === 0) {
        this.re.lastIndex = this.re.lastIndex + 1;
        if (m.index === 0 || m.index >= h.length) continue;
      }
      out.push(fromHostString(h.substring(last, m.index)));
      last = m.index + m[0].length;
    }
    out.push(fromHostString(h.substring(last)));
    return out;
  }
  ReplaceAllStringFunc(s: string, f: ((m: string) => string) | undefined): string {
    return fromHostString(
      this.replaceAll(toHostString(s), (m: string[]): string => toHostString(f!(fromHostString(m[0])))),
    );
  }
  override String(): string {
    return this.src;
  }
  $clone(): regexp_Regexp {
    return this;
  }
}
export function regexp_MustCompile(pattern: string): regexp_Regexp | undefined {
  return new regexp_Regexp(pattern);
}

// Replacements for TypeScript-Go's link stores. Entries are keyed by object
// identity and created from the zero factory on first access.
export class core_LinkStore<K, V> extends GoObject {
  z: () => V;
  entries = new Map<K, V>();
  constructor(z: () => V) {
    super();
    this.z = z;
  }
  Get(key: K): V {
    let v = this.entries.get(key);
    if (v === undefined) {
      v = this.z();
      this.entries.set(key, v);
    }
    return v;
  }
  Has(key: K): boolean {
    return this.entries.has(key);
  }
  TryGet(key: K): V | undefined {
    return this.entries.get(key);
  }
  $clone(): core_LinkStore<K, V> {
    return this;
  }
}
export class checker_nodeLinkStore<V> extends GoObject {
  z: () => V;
  entries = new Map<GoObject, V>();
  constructor(z: () => V) {
    super();
    this.z = z;
  }
  Get(node: GoObject | undefined): V {
    let v = this.entries.get(node!);
    if (v === undefined) {
      v = this.z();
      this.entries.set(node!, v);
    }
    return v;
  }
  Has(node: GoObject | undefined): boolean {
    return this.entries.has(node!);
  }
  TryGet(node: GoObject | undefined): V | undefined {
    return this.entries.get(node!);
  }
  $clone(): checker_nodeLinkStore<V> {
    return this;
  }
}
export class checker_symbolArenaLinkStore<V> extends GoObject {
  z: () => V;
  entries = new Map<GoObject, V>();
  constructor(z: () => V) {
    super();
    this.z = z;
  }
  Get(node: GoObject | undefined): V {
    let v = this.entries.get(node!);
    if (v === undefined) {
      v = this.z();
      this.entries.set(node!, v);
    }
    return v;
  }
  Has(node: GoObject | undefined): boolean {
    return this.entries.has(node!);
  }
  TryGet(node: GoObject | undefined): V | undefined {
    return this.entries.get(node!);
  }
  $clone(): checker_symbolArenaLinkStore<V> {
    return this;
  }
}

export function regexp_Regexp_FindStringSubmatch(re: regexp_Regexp, s: string): string[] {
  re.re.lastIndex = 0;
  const m = re.re.exec(toHostString(s));
  if (m === null) return [];
  const out: string[] = [];
  for (let i = 0; i < m.length; i++) out.push(m[i] === undefined ? '' : fromHostString(m[i]));
  return out;
}

// xxh3: the checker uses 128-bit hashes of key bytes as map keys. The key
// bytes themselves serve as an exact, collision-free key. The zero value is
// distinct from every hash, as in Go.
export class github_com_zeebo_xxh3_Uint128 extends GoObject {
  key: string;
  hashed: boolean;
  constructor(key = '', hashed = false) {
    super();
    this.key = key;
    this.hashed = hashed;
  }
  override String(): string {
    return this.hashed ? 'h' + this.key : 'z';
  }
  $equals(o: github_com_zeebo_xxh3_Uint128): boolean {
    return this.hashed === o.hashed && this.key === o.key;
  }
  Bytes(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.key.length; i++) out.push(this.key.charCodeAt(i));
    return out;
  }
  $clone(): github_com_zeebo_xxh3_Uint128 {
    return this;
  }
  // The halves are 53-bit hashes of the key: stable identities, not xxh3 values.
  get Hi(): number {
    return this.hashed ? fnv53(this.key, 0x811c9dc5) : 0;
  }
  get Lo(): number {
    return this.hashed ? fnv53(this.key, 0x050c5d1f) : 0;
  }
}
function fnv53(s: string, seed: number): number {
  let a = seed >>> 0;
  let b = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return (b & 0x1fffff) * 0x100000000 + a;
}
// Hashes are interned, so equal keys are the same object; generic containers
// keyed by object identity then compare them by value, as Go does.
const hashes = new Map<string, github_com_zeebo_xxh3_Uint128>();
export function github_com_zeebo_xxh3_HashString128(s: string): github_com_zeebo_xxh3_Uint128 {
  let h = hashes.get(s);
  if (h === undefined) {
    h = new github_com_zeebo_xxh3_Uint128(s, true);
    hashes.set(s, h);
  }
  return h;
}
// A streaming hasher whose sum is keyed by the exact bytes written.
export class github_com_zeebo_xxh3_Hasher extends GoObject {
  parts: string[] = [];
  Write(b: number[]): [number, GoObject | undefined] {
    this.parts.push(bytesToString(b));
    return [b.length, undefined];
  }
  WriteString(s: string): [number, GoObject | undefined] {
    this.parts.push(s);
    return [s.length, undefined];
  }
  Reset(): void {
    this.parts = [];
  }
  Sum128(): github_com_zeebo_xxh3_Uint128 {
    return github_com_zeebo_xxh3_HashString128(this.parts.join(''));
  }
  Sum64(): number {
    return fnv53(this.parts.join(''), 0x811c9dc5);
  }
  $clone(): github_com_zeebo_xxh3_Hasher {
    const h = new github_com_zeebo_xxh3_Hasher();
    h.parts = this.parts.slice();
    return h;
  }
}
export function github_com_zeebo_xxh3_Hash128(b: number[]): github_com_zeebo_xxh3_Uint128 {
  return github_com_zeebo_xxh3_HashString128(bytesToString(b));
}

// maps.* for StructMap.
export function structMap_Keys<K, V>(m: StructMap<K, V> | undefined): Seq<K> {
  return (y: ((k: K) => boolean) | undefined): void => {
    if (m !== undefined) for (const k of m.ks.slice()) if (!y!(k)) return;
  };
}
export function structMap_Values<K, V>(m: StructMap<K, V> | undefined): Seq<V> {
  return (y: ((v: V) => boolean) | undefined): void => {
    if (m !== undefined) for (const v of m.vs.slice()) if (!y!(v)) return;
  };
}
export function structMap_Clone<K, V>(m: StructMap<K, V> | undefined): StructMap<K, V> | undefined {
  if (m === undefined) return undefined;
  const out = new StructMap<K, V>(m.keyOf);
  for (const [k, v] of m.entryList()) out.set(k, v);
  return out;
}
export function structMap_Copy<K, V>(dst: StructMap<K, V> | undefined, src: StructMap<K, V> | undefined): void {
  if (src !== undefined) for (const [k, v] of src.entryList()) dst!.set(k, v);
}

// context: a background context that is never cancelled, with values.
export class context_Context extends GoObject {
  parent: context_Context | undefined;
  key: GoObject | undefined;
  val: GoObject | undefined;
  constructor(
    parent: context_Context | undefined = undefined,
    key: GoObject | undefined = undefined,
    val: GoObject | undefined = undefined,
  ) {
    super();
    this.parent = parent;
    this.key = key;
    this.val = val;
  }
  Done(): Chan<Empty> | undefined {
    return undefined;
  }
  Err(): GoObject | undefined {
    return undefined;
  }
  Value(key: GoObject | undefined): GoObject | undefined {
    if (this.key !== undefined && ifaceKey(this.key) === ifaceKey(key)) return this.val;
    return this.parent === undefined ? undefined : this.parent.Value(key);
  }
}
const backgroundContext = new context_Context();
export function context_Background(): context_Context | undefined {
  return backgroundContext;
}
export function context_TODO(): context_Context | undefined {
  return backgroundContext;
}
export function context_WithValue(
  parent: context_Context | undefined,
  key: GoObject | undefined,
  val: GoObject | undefined,
): context_Context | undefined {
  return new context_Context(parent, key, val);
}

// More slices, strings, bytes, errors and math functions.
export function slices_Compact<T>(s: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < s.length; i++) if (i === 0 || s[i] !== s[i - 1]) out.push(s[i]);
  return out;
}
export function slices_CompareFunc<T, U>(a: T[], b: U[], cmp: ((x: T, y: U) => number) | undefined): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = cmp!(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}
export function slices_DeleteFunc<T>(s: T[], del: ((v: T) => boolean) | undefined): T[] {
  const out: T[] = [];
  for (const v of s) if (!del!(v)) out.push(v);
  return out;
}
export function slices_Repeat<T>(s: T[], count: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < count; i++) for (const v of s) out.push(v);
  return out;
}
export function slices_Sorted<T>(seq: Seq<T>): T[] {
  const out = slices_Collect<T>(seq);
  mergeSort(out, cmp_Compare);
  return out;
}
export function strings_Clone(s: string): string {
  return s;
}
export function strings_ContainsFunc(s: string, f: ((r: number) => boolean) | undefined): boolean {
  return strings_IndexFunc(s, f) >= 0;
}
export function unicode_utf8_RuneStart(b: number): boolean {
  return (b & 0xc0) !== 0x80;
}
export function bytes_Equal(a: number[], b: number[]): boolean {
  return slices_Equal(a, b);
}
export function errors_Join(errs: (GoObject | undefined)[]): GoObject | undefined {
  const msgs: string[] = [];
  for (const e of errs) if (e !== undefined) msgs.push(e.Error());
  return msgs.length === 0 ? undefined : new GoError(msgs.join('\n'));
}
export function math_Float64bits(f: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, f, true);
  return view.getUint32(4, true) * 4294967296 + view.getUint32(0, true);
}

// math/big: the subset used for numeric literals.

export class math_big_Int extends GoObject {
  v = 0n;
  SetString(s: string, base: number): [math_big_Int | undefined, boolean] {
    let i = 0;
    let neg = false;
    if (s.length > 0 && (s.charCodeAt(0) === 43 || s.charCodeAt(0) === 45)) {
      neg = s.charCodeAt(0) === 45;
      i = 1;
    }
    let b = base;
    let seps = false;
    if (base === 0) {
      b = 10;
      seps = true;
      if (s.length - i >= 2 && s.charCodeAt(i) === 48) {
        const p = s.charCodeAt(i + 1) | 0x20;
        if (p === 120 || p === 98 || p === 111) {
          b = p === 120 ? 16 : p === 98 ? 2 : 8;
          i += 2;
        } else {
          b = 8;
          i += 1;
        }
      }
    }
    let v = 0n;
    let digits = 0;
    const bb = BigInt(b);
    for (; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 95 && seps) continue;
      let d = 99;
      if (c >= 48 && c <= 57) d = c - 48;
      else if (c >= 97 && c <= 122) d = c - 87;
      else if (c >= 65 && c <= 90) d = c - 55;
      if (d >= b) return [undefined, false];
      v = v * bb + BigInt(d);
      digits++;
    }
    if (digits === 0 && !(base === 0 && b === 8)) return [undefined, false];
    this.v = neg ? -v : v;
    return [this, true];
  }
  Exp(
    x: math_big_Int | undefined,
    y: math_big_Int | undefined,
    _m: math_big_Int | undefined,
  ): math_big_Int | undefined {
    // Only m == nil and y >= 0 are used.
    this.v = x!.v ** y!.v;
    return this;
  }
  Float64(): [number, number] {
    return bigToFloat(this.v);
  }
  Sign(): number {
    return this.v < 0n ? -1 : this.v > 0n ? 1 : 0;
  }
  override String(): string {
    return this.v.toString();
  }
}

export function math_big_NewInt(x: number): math_big_Int | undefined {
  const r = new math_big_Int();
  r.v = BigInt(x);
  return r;
}

export class math_big_Float extends GoObject {
  v = 0n;
  SetPrec(_prec: number): math_big_Float | undefined {
    return this;
  }
  SetInt(x: math_big_Int | undefined): math_big_Float | undefined {
    this.v = x!.v;
    return this;
  }
  Float64(): [number, number] {
    return bigToFloat(this.v);
  }
}

// bigToFloat rounds to the nearest float64 and reports big.Accuracy.
function bigToFloat(v: bigint): [number, number] {
  const f = Number(v);
  if (!Number.isFinite(f)) return [f, f > 0 ? 1 : -1];
  const back = BigInt(f);
  return [f, back < v ? -1 : back > v ? 1 : 0];
}

// collections.SyncMap. Struct keys compare by identity, so caches keyed by
// structs miss rather than share entries.
export class collections_SyncMap<K, V> extends GoObject {
  zk: () => K;
  z: () => V;
  m = new StructMap<K, V>();
  constructor(zk: () => K, z: () => V) {
    super();
    this.zk = zk;
    this.z = z;
  }
  Load(key: K): [V, boolean] {
    const i = this.m.index(key);
    return i < 0 ? [this.z(), false] : [this.m.vs[i], true];
  }
  Store(key: K, value: V): void {
    this.m.set(key, value);
  }
  LoadOrStore(key: K, value: V): [V, boolean] {
    const i = this.m.index(key);
    if (i >= 0) return [this.m.vs[i], true];
    this.m.set(key, value);
    return [value, false];
  }
  Delete(key: K): void {
    this.m.delete(key);
  }
  Clear(): void {
    this.m.clear();
  }
  Range(f: ((k: K, v: V) => boolean) | undefined): void {
    for (const [k, v] of this.m.entryList()) if (!f!(k, v)) return;
  }
  Size(): number {
    return this.m.size;
  }
  ToMap(): Map<K, V> | undefined {
    const out = new Map<K, V>();
    for (const [k, v] of this.m.entryList()) out.set(k, v);
    return out;
  }
  Keys(): ((yield_: ((k: K) => boolean) | undefined) => void) | undefined {
    return (yield_: ((k: K) => boolean) | undefined): void => {
      for (const k of this.m.ks.slice()) if (!yield_!(k)) return;
    };
  }
  Clone(): collections_SyncMap<K, V> | undefined {
    const c = new collections_SyncMap<K, V>(this.zk, this.z);
    for (const [k, v] of this.m.entryList()) c.m.set(k, v);
    return c;
  }
  $clone(): collections_SyncMap<K, V> {
    return this;
  }
}

// printer.FormatGeneratedName, hand-written: scriptc 0.2.5 rejects the
// translated version, which concatenates calls to removeLeadingHash.
export function printer_FormatGeneratedName(
  privateName: boolean,
  prefix: string,
  base: string,
  suffix: string,
): string {
  let name = prefix.length > 0 && prefix.charCodeAt(0) === 35 ? prefix.substring(1) : prefix;
  name += base.length > 0 && base.charCodeAt(0) === 35 ? base.substring(1) : base;
  name += suffix.length > 0 && suffix.charCodeAt(0) === 35 ? suffix.substring(1) : suffix;
  return privateName && !(name.length > 0 && name.charCodeAt(0) === 35) ? '#' + name : name;
}

// time: wall-clock instants in milliseconds and durations in nanoseconds.
export class time_Time extends GoObject {
  ms: number;
  zero: boolean;
  constructor(ms = 0, zero = true) {
    super();
    this.ms = ms;
    this.zero = zero;
  }
  IsZero(): boolean {
    return this.zero;
  }
  UnixMilli(): number {
    return Math.trunc(this.ms);
  }
  UnixNano(): number {
    return Math.trunc(this.ms * 1e6);
  }
  Unix(): number {
    return Math.floor(this.ms / 1000);
  }
  Sub(u: time_Time): number {
    return Math.round((this.ms - u.ms) * 1e6);
  }
  Add(d: number): time_Time {
    return new time_Time(this.ms + d / 1e6, false);
  }
  Before(u: time_Time): boolean {
    return this.ms < u.ms;
  }
  After(u: time_Time): boolean {
    return this.ms > u.ms;
  }
  Equal(u: time_Time): boolean {
    return this.ms === u.ms && this.zero === u.zero;
  }
  Compare(u: time_Time): number {
    return this.ms < u.ms ? -1 : this.ms > u.ms ? 1 : 0;
  }
  $equals(u: time_Time): boolean {
    return this.Equal(u);
  }
  Format(_layout: string): string {
    return fromHostString(new Date(this.ms).toISOString());
  }
  $clone(): time_Time {
    return this;
  }
}
export function time_Now(): time_Time {
  return new time_Time(Date.now(), false);
}
export function time_Since(t: time_Time): number {
  return time_Now().Sub(t);
}
export function time_UnixMilli(ms: number): time_Time {
  return new time_Time(ms, false);
}
export function time_Duration$Nanoseconds(d: number): number {
  return d;
}
export function time_Duration$Seconds(d: number): number {
  return d / 1e9;
}
export function time_Duration$Milliseconds(d: number): number {
  return Math.trunc(d / 1e6);
}

// sort.Slice sorts the slice in x with less, which compares elements by
// index. The elements are compared at their original positions, then moved.
export function sort_Slice(x: GoObject | undefined, less: ((i: number, j: number) => boolean) | undefined): void {
  const arr = (x === undefined ? [] : x.$unbox()) as unknown[];
  const order: number[] = [];
  for (let i = 0; i < arr.length; i++) order.push(i);
  order.sort((a, b) => (less!(a, b) ? -1 : less!(b, a) ? 1 : 0));
  const sorted = order.map((i) => arr[i]);
  for (let i = 0; i < sorted.length; i++) arr[i] = sorted[i];
}
export function sort_SliceStable(x: GoObject | undefined, less: ((i: number, j: number) => boolean) | undefined): void {
  sort_Slice(x, less);
}

// encoding/binary little-endian byte order, used by the API's AST encoder.
export class encoding_binary_littleEndian extends GoObject {
  Uint16(b: number[]): number {
    return b[0] | (b[1] << 8);
  }
  Uint32(b: number[]): number {
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }
  PutUint16(b: number[], v: number): void {
    b[0] = v & 0xff;
    b[1] = (v >>> 8) & 0xff;
  }
  PutUint32(b: number[], v: number): void {
    b[0] = v & 0xff;
    b[1] = (v >>> 8) & 0xff;
    b[2] = (v >>> 16) & 0xff;
    b[3] = (v >>> 24) & 0xff;
  }
  AppendUint16(b: number[], v: number): number[] {
    b.push(v & 0xff, (v >>> 8) & 0xff);
    return b;
  }
  AppendUint32(b: number[], v: number): number[] {
    b.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return b;
  }
  $clone(): encoding_binary_littleEndian {
    return this;
  }
}
export const encoding_binary_LittleEndian = new encoding_binary_littleEndian();

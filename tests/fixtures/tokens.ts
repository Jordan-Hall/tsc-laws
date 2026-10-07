// Scanner fixture: literals, escapes, Unicode, and operators.
const ascii = 'plain' + 'double' + `template ${1 + 2} tail`;
const escapes = "\x41B\u{1F600}\n\t\\'" + '\0';
const numbers = [0, 1_000, 0x1f, 0o17, 0b1010, 1e10, 1.5e-3, 0.5, 123n, 0xffn];
const ünïcödé = 'ß',
  ŝ = 'Σ',
  中文 = '😀',
  abc = 1;
let x = a ?? b;
x ||= 1;
x &&= 2;
x ??= 3;
x **= 2;
x >>>= 1;
label: for (const k of []) {
  if (k?.y?.[0]) continue label;
}
/* block
   comment */ class C<T extends object = {}> {
  #priv = 1;
  static {}
}
@decorator()
class D {}
const big = 9007199254740993;
const arrow = async (a: number): Promise<void> => {};

#!/usr/bin/env node
// @ts-ignore
/* @ts-expect-error */
/** @deprecated use {@link other} @see x */
const numbers = [0, 1_000, 0x1F_ab, 0B1010n, 0o17n, 0777, 089, 1e10, 1.5e-3, .5, 5., 1__0, 1_, 0_1, 0xn, 1e, 1n, 1.5n, 3in, 9007199254740993, 123456789012345678901234567890n];
const strings = ['a\'b', "c\"d", '\x41B\u{1F600}\u{D83D}\uDE00', '\0\08\1\47\477\9', "unterminated
const t = `a${1}b${`nested${2}`}c\u{110000}\xZZ`;
const r = [/a[/]b/gimsuyd, /(?<name>x)\k<name>/v, /[\p{L}--\p{N}]/v, /\p{Script=Greek}\P{Lu}/u, /x{2,1}/, /(?i-s:a)/, /[z-a]/, /\1(a)/, /\k<missing>(?<present>.)/, /[\q{abc}]/v, /a/xx, /unterminated
];
const unicode = { ℮: 1, abc: 2, 𝑥: 3, ä\u{62}: 4, ‿: 5 };
class C { #priv = 1; #b = 2; m() { return this.#priv ?? a?.b ?.5 : 0; } }
a >>>= b >> c >= d;  x **= 2; y ||= z &&= w ??= v;
let é = '  ' + "\
";
<<<<<<< HEAD
const conflict = 1;
=======
const conflict = 2;
>>>>>>> branch
  a<<<<<<< b
@decorator() #! not a shebang
\u00

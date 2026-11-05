// tslaws held to its own laws: the pure parts of the runner, checked by the runner. Run with `npm run laws`.
import { isDeepStrictEqual } from 'node:util';
import { assume, law } from 'tslaws';
import { lawHash } from 'tslaws/internal/lock';
import { lowerLawFile, usesLegacySyntax } from 'tslaws/internal/lower';
import { decodeExample, encodeExample } from 'tslaws/internal/regressions';
import type { ManifestLaw } from 'tslaws/internal/types';

const manifest = (text: string, proved: boolean): ManifestLaw => ({
  file: 'a.laws.ts',
  name: 'x',
  exported: true,
  proved,
  line: 1,
  params: [],
  body: '',
  text,
  problems: [],
});

// A counterexample survives the corpus: what is stored decodes to the value that was found.
law('stored counterexamples decode to themselves', (xs: number[], s: string, b: boolean) => {
  const args = [xs, s, b, undefined, 10n, -0];
  return isDeepStrictEqual(decodeExample(encodeExample(args)), args);
});

law('stored objects keep keys that look like tags', (key: string, n: number) => {
  const args = [{ [key]: n, $t: 'date', v: n }];
  return isDeepStrictEqual(decodeExample(encodeExample(args)), args);
});

// The lock ignores layout but not meaning.
law('the lock hash ignores whitespace', (text: string) => {
  const spaced = text.replace(/\s+/g, '   \n\t ');
  return lawHash(manifest(text, false)) === lawHash(manifest(spaced, false));
});

law('the lock hash sees a law become proved', (text: string) =>
  lawHash(manifest(text, false)) !== lawHash(manifest(text, true)),
);

// Lowering keeps what a person wrote: the name, the line, and a function the runner can load.
law('a law keeps its name and its line when lowered', (name: string, blank: number) => {
  assume(blank >= 0 && blank <= 5);
  const text = `${'\n'.repeat(blank)}law(${JSON.stringify(name)}, (a: number) =>\n  a === a);\n`;
  const lowered = lowerLawFile('x.laws.ts', text);
  const found = lowered.laws[0];
  return (
    found !== undefined &&
    found.name === name &&
    found.line === blank + 1 &&
    found.problems.length === 0 &&
    /^[A-Za-z_$][\w$]*$/.test(found.symbol ?? '') &&
    lowered.text.split('\n')[blank]?.startsWith('export function ') === true
  );
});

law('a repeated law name is flagged', (name: string) => {
  const one = `law(${JSON.stringify(name)}, (a: number) => a === a);\n`;
  const { laws } = lowerLawFile('x.laws.ts', `${one}${one}`);
  return laws.length === 2 && laws[1]!.problems.length > 0;
});

law('call syntax is not mistaken for the keyword syntax', (name: string) =>
  !usesLegacySyntax(`law(${JSON.stringify(name)}, (a: number) => a === a);\n`),
);

import { readFileSync, writeFileSync } from 'node:fs';

const path = 'upstream/typescript-go/internal/stringutil/js_case_generated.go';
const source = readFileSync(path, 'utf8');
const decode = (text) =>
  JSON.parse(text.replace(/\\U([0-9a-fA-F]{8})/g, (_, cp) => String.fromCodePoint(parseInt(cp, 16))));
const hex = (value) => Buffer.from(value, 'utf8').toString('hex');
const entries = [...source.matchAll(/(0x[0-9A-F]+):\s*\{lower: ("(?:\\.|[^"\\])*"), upper: ("(?:\\.|[^"\\])*"),/g)];
if (entries.length < 2900) throw new Error('Incomplete upstream case mapping table');
const ranges = (name) => {
  const start = source.indexOf('var ' + name + ' =');
  const end = source.indexOf('\n}', start);
  if (start < 0 || end < 0) throw new Error('Missing upstream range table: ' + name);
  return [...source.slice(start, end).matchAll(/\{(0x[0-9A-Fa-f]+), (0x[0-9A-Fa-f]+), (\d+)\}/g)].flatMap((match) =>
    match.slice(1).map(Number),
  );
};
const emit = (name, values) =>
  'export const ' +
  name +
  ' = [\n' +
  Array.from(
    { length: Math.ceil(values.length / 12) },
    (_, i) =>
      '  ' +
      values
        .slice(i * 12, i * 12 + 12)
        .map((v) => JSON.stringify(v))
        .join(', ') +
      ',',
  ).join('\n') +
  '\n];\n';
const output =
  '// Generated from ' +
  path +
  ' by tools/generate-case-mappings.mjs.\n' +
  '// Unicode 15.1.0; preserves the pinned tsgo case tables. See THIRD_PARTY_NOTICES.md.\n' +
  '// Copyright Microsoft Corporation. Licensed under Apache-2.0.\n' +
  emit(
    'caseCodePoints',
    entries.map((e) => Number(e[1])),
  ) +
  emit(
    'caseLower',
    entries.map((e) => hex(decode(e[2]))),
  ) +
  emit(
    'caseUpper',
    entries.map((e) => hex(decode(e[3]))),
  ) +
  emit('caseCasedRanges', ranges('unicodeCasedRanges')) +
  emit('caseIgnorableRanges', ranges('unicodeCaseIgnorableRanges'));
writeFileSync('src/checker/case-mappings.ts', output);
console.log('Generated ' + entries.length + ' case mappings');

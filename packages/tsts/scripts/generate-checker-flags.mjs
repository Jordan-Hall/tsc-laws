import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const source = readFileSync('../../upstream/typescript-go/internal/checker/types.go', 'utf8');
const identity = JSON.parse(readFileSync('../../upstream.json', 'utf8'));
if (
  execFileSync('git', ['-C', '../../upstream/typescript-go', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !==
  identity.commit
)
  throw new Error('Upstream revision does not match upstream.json');
mkdirSync('src/checker', { recursive: true });
let output = `// Ported from microsoft/typescript-go ${identity.commit}; modified for TypeScript.\n// Copyright Microsoft Corporation. Licensed under Apache-2.0.\n`;
for (const prefix of ['TypeFlags', 'ObjectFlags', 'ElementFlags', 'IndexFlags', 'AccessFlags', 'VarianceFlags']) {
  const start = source.indexOf(`\n\t${prefix}${prefix === 'VarianceFlags' ? 'Invariant' : 'None'}`);
  const end = source.indexOf('\n)', start);
  let block = source.slice(start, end).replace(/\/\/[^\n]*/g, '');
  block = block.replace(new RegExp(`\\b${prefix}(\\w+)`, 'g'), '$1');
  block = block.replace(new RegExp(`\\b${prefix}\\b`, 'g'), '');
  const entries = block
    .split(/\n(?=\s*[A-Za-z]\w*\s*=)/)
    .map((s) => s.trim())
    .filter(Boolean);
  const expressions = new Map(
    entries.map((s) => {
      const index = s.indexOf('=');
      return [s.slice(0, index).trim(), s.slice(index + 1).trim()];
    }),
  );
  const values = new Map();
  function constant(name) {
    if (values.has(name)) return values.get(name);
    const expression = expressions.get(name).replace(/\b[A-Za-z]\w*\b/g, (word) => String(constant(word)));
    if (!/^[\d\s()+|&^<>-]+$/.test(expression)) throw new Error('Unrecognized flag expression: ' + expression);
    const value = Function('return (' + expression + ') >>> 0')();
    values.set(name, value);
    return value;
  }
  output += `export enum ${prefix} {\n${[...expressions.keys()].map((name) => `  ${name} = ${constant(name)},`).join('\n')}\n}\n`;
}
const mappedSource = readFileSync('../../upstream/typescript-go/internal/checker/checker.go', 'utf8');
output += 'export enum MappedTypeModifiers {\n';
for (const name of ['IncludeReadonly', 'ExcludeReadonly', 'IncludeOptional', 'ExcludeOptional']) {
  const match = mappedSource.match(
    new RegExp(`MappedTypeModifiers${name}\\s+MappedTypeModifiers\\s*=\\s*1\\s*<<\\s*(\\d+)`),
  );
  if (!match) throw new Error('Missing mapped modifier: ' + name);
  output += `  ${name} = ${2 ** Number(match[1])},\n`;
}
output += '}\n';
const symbolSource = readFileSync('../../upstream/typescript-go/internal/ast/symbolflags.go', 'utf8');
output += 'export enum SymbolFlags {\n';
for (const name of ['Class', 'ConstEnum', 'RegularEnum', 'ValueModule', 'TypeLiteral', 'ObjectLiteral']) {
  const match = symbolSource.match(new RegExp(`SymbolFlags${name}\\s+SymbolFlags\\s*=\\s*1\\s*<<\\s*(\\d+)`));
  if (!match) throw new Error('Missing symbol flag: ' + name);
  output += `  ${name} = ${2 ** Number(match[1])},\n`;
}
output += '  Enum = ConstEnum | RegularEnum,\n}\n';
output += 'export enum Ternary { False = 0, Unknown = 1, Maybe = 3, True = -1 }\n';
writeFileSync('src/checker/flags.ts', output);

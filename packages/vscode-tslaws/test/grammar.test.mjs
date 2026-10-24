import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vsctm from 'vscode-textmate';
import onig from 'vscode-oniguruma';

const require = createRequire(import.meta.url);
const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm'));
await onig.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
const injection = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL('../syntaxes/tslaws.injection.json', import.meta.url)), 'utf8'),
);
const host = {
  scopeName: 'source.ts',
  patterns: [
    { match: '//.*$', name: 'comment.line.stub' },
    { begin: '"', end: '"', name: 'string.quoted.stub' },
  ],
};
const registry = new vsctm.Registry({
  onigLib: Promise.resolve({
    createOnigScanner: (s) => new onig.OnigScanner(s),
    createOnigString: (s) => new onig.OnigString(s),
  }),
  loadGrammar: async (scope) => (scope === 'source.ts' ? host : scope === 'source.tslaws' ? injection : null),
  getInjections: (scope) => (scope === 'source.ts' ? ['source.tslaws'] : []),
});
const grammar = await registry.loadGrammar('source.ts');

function scopesOf(text, token) {
  const out = [];
  let state = vsctm.INITIAL;
  for (const line of text.split('\n')) {
    const r = grammar.tokenizeLine(line, state);
    for (const t of r.tokens) if (line.slice(t.startIndex, t.endIndex) === token) out.push(t.scopes);
    state = r.ruleStack;
  }
  return out;
}
const isLaw = (text, word = 'law') => scopesOf(text, word).some((s) => s.includes('keyword.declaration.law.tslaws'));

test('law declaration scopes', () => {
  const s = scopesOf('law foo(a, b) { }', 'law')[0];
  assert.ok(s.includes('storage.type.law.tslaws') && s.includes('keyword.declaration.law.tslaws'));
  assert.ok(scopesOf('law foo(a, b) { }', 'foo')[0].includes('entity.name.function.law.tslaws'));
});
test('export, generics, arrow form', () => {
  assert.ok(isLaw('export law foo<T>(a: T) => true;'));
  assert.ok(isLaw('law g(x) => x;'));
});
test('law proved', () => {
  const s = scopesOf('law proved foo(a) { }', 'proved')[0];
  assert.ok(s.includes('storage.modifier.proved.tslaws'));
  assert.ok(isLaw('export law proved foo(a) { }'));
  assert.ok(scopesOf('law proved foo(a) { }', 'foo')[0].includes('entity.name.function.law.tslaws'));
});
for (const neg of ['law(1)', 'obj.law x(', 'const law = 1', 'law = 2', 'law\nfoo()', 'lawful x(', 'x.law foo(1)']) {
  test(`not a law: ${JSON.stringify(neg)}`, () => {
    assert.ok(!isLaw(neg));
    assert.ok(
      !scopesOf(neg, 'foo')
        .concat(scopesOf(neg, 'x'))
        .some((s) => s.includes('entity.name.function.law.tslaws')),
    );
  });
}
test('not inside comment or string', () => {
  assert.ok(!isLaw('// law foo(a)', 'law'));
  assert.ok(!scopesOf('"law foo(a)"', 'law foo(a)').some((s) => s.includes('storage.type.law.tslaws')));
});

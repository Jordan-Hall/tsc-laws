// The tsserver plugin against a real tsserver (the `typescript` package) and a fixture project. No GUI.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { makeProject, startTsserver, locate, tslawsBuilt } from './tsserver-client.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const init = require('../ts-plugin/index.js');

const rules = `export function total(price: number, coupon: number): number {
  return price - coupon;
}
export const limit = 10;
`;

const lawsText = `import { assume } from 'tslaws';
import { total, limit } from './rules';

export law totalNeverNegative(price: number, coupon: number) {
  assume(price >= 0 && coupon >= 0 && coupon <= price);
  return total(price, coupon) >= 0;
}
export law proved   zeroCoupon (price: number) { return total(price, 0) === price; }
export async law asyncOne(price: number) { await Promise.resolve(); return price === price; }
export law arrowOne(a: number, b: number): boolean => a + b === b + a;
export law proved arrowProved(a: number) => total(a, 0) === a;
export async law asyncArrow(a: number) => (await Promise.resolve(a)) === a;
export law generic<T>(x: T) { return x === x; }
export law oneLine(a: number) { return a >= 0 || a < 0; } export const afterLaw: number = limit + 1;
export law spread(
  a: number,
  b: Array<{ x: number }>,
): boolean {
  return a === a && b.length >= 0;
}
export law /* between */ commented(a: number) { return a === a; }
export law nested(a: number) { const f = (n: number) => \`law inner(\${n}) {}\`; return f(a) !== ''; }
`;

const project = makeProject({
  'src/rules.ts': rules,
  'src/rules.laws.ts': lawsText,
  'src/plain.ts': `export const n: number = 'text';\nexport const m = n + 1;\n`,
  'src/identifier.ts': `export const law = 1;\nexport const o = { law: 2 };\nexport const x = o.law + law;\nexport const bad: string = x;\n`,
  'src/complete.laws.ts': `import { total } from './rules';\nexport law c(a: number) { const r = tot; return r >= 0; }\n`,
});
const server = startTsserver();
const bare = startTsserver({ plugin: false });
after(async () => {
  await server.close();
  await bare.close();
  project.dispose();
});

const lawFile = project.file('src/rules.laws.ts');
const rulesFile = project.file('src/rules.ts');
const at = (needle, nth = 0, text = lawsText) => locate(text, needle, nth);
const pos = (p) => `${p.line}:${p.offset}`;

async function diagnostics(s, file) {
  await s.open(file, project.root);
  const syntax = await s.request('syntacticDiagnosticsSync', { file });
  const semantic = await s.request('semanticDiagnosticsSync', { file });
  return { syntax, semantic };
}

test('without the plugin tsserver reports syntax errors on every law', async () => {
  const { syntax } = await diagnostics(bare, lawFile);
  assert.ok(syntax.length >= 10, `expected many syntax errors, got ${syntax.length}`);
});

test('a file full of law declarations has no syntax errors', async () => {
  const { syntax } = await diagnostics(server, lawFile);
  assert.deepEqual(syntax, []);
});

test(
  'law declarations of every form type-check, and tslaws types are resolved',
  { skip: !tslawsBuilt && 'run npm run build -w tslaws' },
  async () => {
    const { semantic } = await diagnostics(server, lawFile);
    assert.deepEqual(
      semantic.map((d) => `${pos(d.start)} ${d.code} ${d.text}`),
      [],
    );
    const q = await server.request('quickinfo', { file: lawFile, ...at('assume(price') });
    assert.match(q.displayString, /assume\(condition: boolean\): asserts condition/);
  },
);

test('a real type error inside a law body is reported at its original position', async () => {
  const file = project.file('src/errors.laws.ts');
  const text = [
    `export law first(a: number) { const s: string = a; return s !== ''; }`,
    `export law proved second(a: number) {`,
    `  const t: boolean = 'nope';`,
    `  return t;`,
    `}`,
    `export async law third(a: number) => a.nope === 1;`,
    `export law fourth<T>(a: number): boolean => zzzNothing;`,
    ``,
  ].join('\n');
  project.write('src/errors.laws.ts', text);
  const { syntax, semantic } = await diagnostics(server, file);
  assert.deepEqual(syntax, []);
  const found = semantic.map((d) => ({ at: pos(d.start), end: pos(d.end), code: d.code }));
  assert.deepEqual(found, [
    {
      at: pos(at('s: string', 0, text)),
      end: pos({ line: 1, offset: at('s: string', 0, text).offset + 1 }),
      code: 2322,
    },
    {
      at: pos(at('t: boolean', 0, text)),
      end: pos({ line: 3, offset: at('t: boolean', 0, text).offset + 1 }),
      code: 2322,
    },
    {
      at: pos(at('nope === 1', 0, text)),
      end: pos({ line: 6, offset: at('nope === 1', 0, text).offset + 4 }),
      code: 2339,
    },
    {
      at: pos(at('zzzNothing', 0, text)),
      end: pos({ line: 7, offset: at('zzzNothing', 0, text).offset + 10 }),
      code: 2304,
    },
  ]);
});

test('hover and definition on symbols that follow a law on the same line', async () => {
  await server.open(lawFile, project.root);
  const afterLaw = await server.request('quickinfo', { file: lawFile, ...at('afterLaw') });
  assert.match(afterLaw.displayString, /const afterLaw: number/);
  assert.equal(pos(afterLaw.start), pos(at('afterLaw')));
  const limit = await server.request('quickinfo', { file: lawFile, ...at('limit +') });
  assert.match(limit.displayString, /const limit: 10/);
  const def = await server.request('definition', { file: lawFile, ...at('limit +') });
  assert.equal(def[0].file, rulesFile);
  assert.equal(pos(def[0].start), pos(locate(rules, 'limit')));
  // definition inside a law body, in a block law and in an arrow law
  const inBlock = await server.request('definition', { file: lawFile, ...at('total(price, coupon) >= 0') });
  assert.equal(inBlock[0].file, rulesFile);
  const inArrow = await server.request('definition', { file: lawFile, ...at('total(a, 0)') });
  assert.equal(inArrow[0].file, rulesFile);
});

test('the law itself: hover, definition, references and rename sit on the original name', async () => {
  await server.open(lawFile, project.root);
  for (const name of ['totalNeverNegative', 'zeroCoupon', 'arrowOne', 'arrowProved', 'generic', 'commented']) {
    const q = await server.request('quickinfo', { file: lawFile, ...at(name) });
    assert.match(q.displayString, new RegExp(`(function|const) ${name}`), name);
    assert.equal(pos(q.start), pos(at(name)), name);
    assert.equal(q.end.offset - q.start.offset, name.length, name);
    const rename = await server.request('rename', { file: lawFile, ...at(name) });
    assert.equal(rename.info.canRename, true, name);
    assert.equal(rename.locs[0].locs[0].start.line, at(name).line, name);
    assert.equal(rename.locs[0].locs[0].start.offset, at(name).offset, name);
  }
});

test('references and rename of a function reach its uses inside laws at the original offsets', async () => {
  await server.open(rulesFile, project.root);
  await server.open(lawFile, project.root);
  const refs = await server.request('references', { file: rulesFile, ...locate(rules, 'total') });
  const inLaws = refs.refs.filter((r) => r.file === lawFile).map((r) => pos(r.start));
  assert.ok(inLaws.includes(pos(at('total(price, coupon) >= 0'))), inLaws.join());
  assert.ok(inLaws.includes(pos(at('total(price, 0)'))));
  assert.ok(inLaws.includes(pos(at('total(a, 0)'))));
  const rename = await server.request('rename', { file: rulesFile, ...locate(rules, 'limit') });
  const spans = rename.locs.find((l) => l.file === lawFile).locs.map((l) => pos(l.start));
  assert.ok(spans.includes(pos(at('limit +'))), spans.join());
  // every reported span covers the identifier it renames
  const lines = lawsText.split('\n');
  for (const l of rename.locs.find((x) => x.file === lawFile).locs) {
    assert.equal(lines[l.start.line - 1].slice(l.start.offset - 1, l.end.offset - 1), 'limit');
  }
});

test('completions inside a law body', async () => {
  const file = project.file('src/complete.laws.ts');
  await server.open(file, project.root);
  const text = fs.readFileSync(file, 'utf8');
  const where = at('tot;', 0, text);
  const info = await server.request('completionInfo', { file, line: where.line, offset: where.offset + 3 });
  assert.ok(info.entries.some((e) => e.name === 'total'));
  assert.ok(info.entries.some((e) => e.name === 'a'));
});

test('the navigation tree lists the laws at their original positions', async () => {
  await server.open(lawFile, project.root);
  const tree = await server.request('navtree', { file: lawFile });
  const names = new Map(tree.childItems.map((c) => [c.text, c.nameSpan]));
  for (const name of [
    'totalNeverNegative',
    'zeroCoupon',
    'asyncOne',
    'arrowOne',
    'arrowProved',
    'generic',
    'oneLine',
    'spread',
  ]) {
    assert.ok(names.has(name), name);
    assert.equal(pos(names.get(name).start), pos(at(`${name}`)), name);
  }
});

test('edits arrive in order: a new law, a broken law and a fixed one', async () => {
  const file = project.file('src/live.laws.ts');
  project.write('src/live.laws.ts', `export law a(x: number) { return x === x; }\n`);
  await server.open(file, project.root);
  assert.deepEqual((await server.request('semanticDiagnosticsSync', { file })).length, 0);
  // add a second law with a type error after the first
  await server.request('change', {
    file,
    line: 2,
    offset: 1,
    endLine: 2,
    endOffset: 1,
    insertString: `export law proved b(y: number) { const z: string = y; return true; }\n`,
  });
  assert.deepEqual(await server.request('syntacticDiagnosticsSync', { file }), []);
  const broken = await server.request('semanticDiagnosticsSync', { file });
  assert.equal(broken.length, 1);
  assert.equal(pos(broken[0].start), '2:' + (`export law proved b(y: number) { const `.length + 1));
  // fix it
  await server.request('change', {
    file,
    line: 2,
    offset: 1,
    endLine: 3,
    endOffset: 1,
    insertString: `export law b(y: number) { return y === y; }\n`,
  });
  assert.deepEqual(await server.request('semanticDiagnosticsSync', { file }), []);
});

test('files with CRLF line endings map the same way', async () => {
  const file = project.file('src/crlf.laws.ts');
  const text = `export law a(x: number) {\r\n  const s: string = x;\r\n  return s === '';\r\n}\r\nexport law proved b(y: number) => y === y;\r\n`;
  fs.writeFileSync(file, text);
  await server.open(file, project.root);
  const semantic = await server.request('semanticDiagnosticsSync', { file });
  assert.deepEqual(await server.request('syntacticDiagnosticsSync', { file }), []);
  assert.equal(semantic.length, 1);
  assert.equal(pos(semantic[0].start), '2:9');
  const q = await server.request('quickinfo', { file, line: 5, offset: 19 });
  assert.match(q.displayString, /const b/);
});

test('a normal file in the same project is untouched and reports its own errors', async () => {
  const file = project.file('src/plain.ts');
  const withPlugin = await diagnostics(server, file);
  const without = await diagnostics(bare, file);
  assert.deepEqual(withPlugin, without);
  assert.equal(withPlugin.semantic.length, 1);
  assert.equal(pos(withPlugin.semantic[0].start), '1:14');
  const q = await server.request('quickinfo', { file, line: 2, offset: 14 });
  assert.match(q.displayString, /const m: number/);
});

test('law as an ordinary identifier is left alone', async () => {
  const file = project.file('src/identifier.ts');
  const { syntax, semantic } = await diagnostics(server, file);
  assert.deepEqual(syntax, []);
  assert.equal(semantic.length, 1);
  assert.equal(pos(semantic[0].start), '4:14');
  assert.equal(semantic[0].code, 2322);
  const q = await server.request('quickinfo', { file, line: 3, offset: 26 });
  assert.match(q.displayString, /const law: 1/);
});

test('a module of laws that nobody imports does not disturb the files it imports', async () => {
  await server.open(rulesFile, project.root);
  assert.deepEqual(await server.request('semanticDiagnosticsSync', { file: rulesFile }), []);
});

test('the plugin leaves a file with no law the very snapshot tsserver had, and rewrites one with a law', () => {
  const plugin = init({ typescript: ts });
  const plain = ts.ScriptSnapshot.fromString('export const law = 1;\nexport const o = { law };\n');
  const law = ts.ScriptSnapshot.fromString('export law a(x: number) { return x === x; }\n');
  const host = {
    getScriptSnapshot: (f) =>
      f.endsWith('plain.ts') ? plain : f.endsWith('.d.ts') ? law : f.endsWith('law.ts') ? law : undefined,
    getScriptVersion: () => '1',
  };
  plugin.create({
    languageServiceHost: host,
    languageService: { getQuickInfoAtPosition: () => undefined },
    project: {},
    config: {},
  });
  assert.equal(host.getScriptSnapshot('/p/plain.ts'), plain);
  assert.equal(host.getScriptSnapshot('/p/x.d.ts'), law);
  assert.equal(host.getScriptSnapshot('/p/gone.ts'), undefined);
  const rewritten = host.getScriptSnapshot('/p/x.law.ts');
  assert.notEqual(rewritten, law);
  assert.equal(rewritten.getText(0, rewritten.getLength()), 'export function a(x: number) { return x === x; }\n');
  assert.equal(law.getText(0, law.getLength()), 'export law a(x: number) { return x === x; }\n');
});

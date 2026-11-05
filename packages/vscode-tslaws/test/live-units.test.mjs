import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { functionStatus, uncoveredStatus, ageText } = require('../src/live-status.js');
const { createLiveGuard, createCpuSampler } = require('../src/live-guard.js');
const { saveCache, loadCache } = require('../src/live-cache.js');
const { liveEnabled } = require('../src/settings.js');
const { proposedPath, parametersOf, lawSkeleton, addToProposed } = require('../src/law-skeleton.js');
const { buildNavigation, importsOf, resolveSpecifier, functionIdsFor, wordAt } = require('../src/law-index.js');
const { buildTree } = require('../src/laws-tree.js');

const entry = (...laws) => ({ laws: laws.map((l) => ({ file: 'a.laws.ts', name: l.name ?? 'l', ...l })) });
const ctx = (over = {}) => ({
  recordOf: () => undefined,
  paramsOf: () => ['price', 'coupon'],
  isRunning: () => false,
  ranAt: () => 1000,
  touched: () => 0,
  functionFile: 'a.ts',
  now: 1000 + 3 * 60_000,
  ...over,
});

test('the status text for every state', () => {
  assert.deepEqual(functionStatus(entry({ status: 'proved' }), ctx()), { kind: 'proved', tone: 'ok', text: 'proved' });
  assert.equal(functionStatus(entry({ status: 'proved' }, { status: 'bounded', name: 'm' }), ctx()).text, 'bounded');
  assert.equal(
    functionStatus(
      entry({ status: 'tested', runs: 24 }),
      ctx({ recordOf: (f, n) => ({ status: 'tested', runs: 24, name: n }) }),
    ).text,
    'tested 24 runs',
  );
  assert.equal(
    functionStatus(entry({ status: 'tested' }), ctx({ recordOf: () => ({ status: 'tested' }) })).text,
    'tested',
  );
  const failed = { status: 'failed', counterexample: '[0,1]', name: 'l', file: 'a.laws.ts' };
  assert.equal(
    functionStatus(entry({ status: 'failed' }), ctx({ recordOf: () => failed })).text,
    'failing: counterexample (price=0, coupon=1)',
  );
  assert.equal(
    functionStatus(entry({ status: 'failed' }, { status: 'failed', name: 'm' }), ctx({ recordOf: () => failed })).text,
    'failing: counterexample (price=0, coupon=1) (+1 more)',
  );
  assert.equal(
    functionStatus(
      entry({ status: 'failed' }),
      ctx({ recordOf: () => ({ status: 'failed', message: 'threw\nstack' }) }),
    ).text,
    'failing: threw',
  );
  assert.equal(functionStatus(entry({ status: 'open', name: 'o' }), ctx()).text, 'open: o');
  assert.deepEqual(functionStatus(entry({ status: 'proved' }), ctx({ isRunning: () => true })), {
    kind: 'running',
    tone: 'muted',
    text: 'running…',
  });
  assert.equal(functionStatus(entry({ status: 'proved' }), ctx({ touched: () => 2000 })).text, 'stale · ran 3m ago');
  assert.equal(
    functionStatus(entry({ status: 'proved' }), ctx({ touched: () => 2000, ranAt: () => undefined })).text,
    'stale',
  );
  assert.equal(uncoveredStatus().kind, 'uncovered');
  assert.deepEqual([0, 50_000, 5 * 60_000, 3 * 3600_000, 5 * 86400_000].map(ageText), [
    'just now',
    '1m ago',
    '5m ago',
    '3h ago',
    '5d ago',
  ]);
});

test('the guard: busy machine, slow run, pause and resume, one at a time', () => {
  let load = 0.1;
  let limit = 0.8;
  const g = createLiveGuard({ busy: () => load, limit: () => limit, maxSeconds: () => 10 });
  assert.deepEqual(g.check(), { ok: true });
  load = 0.95;
  assert.deepEqual(g.check(), { ok: false, reason: 'busy' });
  limit = 0.99;
  assert.equal(g.check().ok, true);
  load = 0.1;
  g.started();
  assert.deepEqual(g.check(), { ok: false, reason: 'running' });
  g.finished(9_000);
  assert.equal(g.check().ok, true);
  g.started();
  g.finished(11_000);
  assert.deepEqual(g.check(), { ok: false, reason: 'slow', seconds: 11 });
  assert.equal(g.stoppedBySpeed, 11);
  assert.equal(g.toggle(), false, 'resuming clears the stop');
  assert.equal(g.check().ok, true);
  assert.equal(g.toggle(), true);
  assert.deepEqual(g.check(), { ok: false, reason: 'paused' });
  assert.equal(g.toggle(), false);
});

test('the cpu sampler reads the busy share since the last read', () => {
  let t = { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
  const sampler = createCpuSampler(() => [{ times: t }]);
  t = { user: 90, nice: 0, sys: 0, idle: 10, irq: 0 };
  assert.equal(sampler.read(), 0.9);
  t = { user: 90, nice: 0, sys: 0, idle: 110, irq: 0 };
  assert.equal(sampler.read(), 0);
  assert.equal(sampler.read(), 0, 'no time passed');
});

test('the cache round-trips and ignores what it cannot read', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tslaws-cache-'));
  try {
    const io = { fs, path, root };
    assert.equal(loadCache(io), null);
    const ranAt = new Map([['a::b', 5]]);
    assert.equal(
      saveCache(io, { records: [{ file: 'a', name: 'b', status: 'proved' }], ranAt, compilerText: 'x' }),
      true,
    );
    const back = loadCache(io);
    assert.deepEqual(back.records, [{ file: 'a', name: 'b', status: 'proved' }]);
    assert.deepEqual([...back.ranAt], [['a::b', 5]]);
    assert.equal(back.compilerText, 'x');
    fs.writeFileSync(path.join(root, '.tslaws', 'last-report.json'), '{"version":99}');
    assert.equal(loadCache(io), null);
    fs.writeFileSync(path.join(root, '.tslaws', 'last-report.json'), 'nope');
    assert.equal(loadCache(io), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('live results: auto needs tslaws.json and no chosen run mode; pause wins', () => {
  assert.equal(liveEnabled({ hasConfig: true, runExplicit: false }), true);
  assert.equal(liveEnabled({ hasConfig: false, runExplicit: false }), false);
  assert.equal(liveEnabled({ hasConfig: true, runExplicit: true }), false);
  assert.equal(liveEnabled({ setting: 'on', hasConfig: false, runExplicit: true }), true);
  assert.equal(liveEnabled({ setting: 'off', hasConfig: true, runExplicit: false }), false);
  assert.equal(liveEnabled({ setting: 'on', hasConfig: true, runExplicit: false, paused: true }), false);
  assert.equal(liveEnabled({ setting: 'nonsense', hasConfig: true, runExplicit: false }), true);
});

test('a proposed law: the path, the parameters and the skeleton', () => {
  assert.equal(proposedPath('src/cart.ts'), 'src/cart.proposed.laws.ts');
  for (const no of ['src/cart.laws.ts', 'src/cart.proposed.laws.ts', 'a.d.ts', 'a.browser.laws.ts', 'a.js'])
    assert.equal(proposedPath(no), null, no);
  const text =
    'export function total(price: number, coupon: number): number {}\nexport const f = async <T>(a: Map<T, number>, {x}: {x:number}, ...r: number[]) => 1;\n';
  assert.deepEqual(parametersOf(text, 'total'), [
    { name: 'price', type: 'number' },
    { name: 'coupon', type: 'number' },
  ]);
  assert.deepEqual(
    parametersOf(text, 'f').map((p) => p.name),
    ['a', 'arg2', 'r'],
  );
  assert.equal(parametersOf(text, 'missing'), null);
  const skeleton = lawSkeleton({ name: 'total', sourceRel: 'src/cart.ts', sourceText: text });
  assert.match(skeleton, /^import \{ total \} from '\.\/cart';/);
  assert.match(
    skeleton,
    /export law totalHolds\(price: number, coupon: number\) \{\n {2}const result = total\(price, coupon\);/,
  );
  const first = addToProposed('', 'total', skeleton);
  assert.equal(first.added, true);
  assert.equal(addToProposed(first.text, 'total', skeleton).added, false);
  const second = addToProposed(first.text, 'f', lawSkeleton({ name: 'f', sourceRel: 'src/cart.ts', sourceText: text }));
  assert.equal(second.added, true);
  assert.equal(second.text.split("import { total } from './cart';").length, 2, 'no repeated import');
  assert.match(second.text, /import \{ f \} from '\.\/cart';/);
});

const files = {
  'src/cart.ts': 'export function total(a: number): number { return a; }\nexport const other = 1;\n',
  'src/util/index.ts': 'export function helper() {}\n',
  'src/cart.laws.ts':
    "import { total as t } from './cart';\nimport * as u from './util';\nimport { assume } from 'tslaws';\nexport law one(a: number) { return t(a) >= 0; }\nexport law two(a: number) => u.helper() === undefined;\nexport law three(a: number) { return a === a; }\n",
};
const read = (rel) => files[rel];
const exists = (rel) => rel in files;

test('imports resolve to project files, with aliases and namespaces', () => {
  assert.equal(resolveSpecifier('src/cart.laws.ts', './cart', exists), 'src/cart.ts');
  assert.equal(resolveSpecifier('src/cart.laws.ts', './util', exists), 'src/util/index.ts');
  assert.equal(resolveSpecifier('src/cart.laws.ts', './nothing', exists), null);
  const { named, namespaces } = importsOf(files['src/cart.laws.ts'], 'src/cart.laws.ts', exists);
  assert.deepEqual([...named], [['t', { file: 'src/cart.ts', name: 'total' }]]);
  assert.deepEqual([...namespaces], [['u', 'src/util/index.ts']]);
});

test('without a report the laws files imports say which functions a law exercises', () => {
  const nav = buildNavigation({ records: null, lawFiles: ['src/cart.laws.ts'], readText: read, exists });
  assert.deepEqual(
    nav.laws.map((l) => [l.name, l.functions.map((f) => `${f.file}:${f.name}`), l.viaReport]),
    [
      ['one', ['src/cart.ts:total'], false],
      ['two', ['src/util/index.ts:helper'], false],
      ['three', [], false],
    ],
  );
  assert.deepEqual([...nav.byFunction.keys()], ['src/cart.ts::total', 'src/util/index.ts::helper']);
});

test('a report overrides the static guess', () => {
  const records = [
    {
      file: 'src/cart.laws.ts',
      name: 'three',
      status: 'failed',
      exercises: [{ name: 'other', declaration: { file: 'src/cart.ts', line: 2, column: 14 }, call: undefined }],
    },
  ];
  const nav = buildNavigation({ records, lawFiles: ['src/cart.laws.ts'], readText: read, exists });
  const three = nav.laws.find((l) => l.name === 'three');
  assert.equal(three.viaReport, true);
  assert.equal(three.status, 'failed');
  assert.deepEqual(
    three.functions.map((f) => f.name),
    ['other'],
  );
});

test('the function under the cursor: declared here, imported, or a namespace member', () => {
  const text = files['src/cart.laws.ts'];
  const ids = (line, character) => functionIdsFor({ rel: 'src/cart.laws.ts', text, line, character, exists }).ids;
  assert.deepEqual(ids(3, 36), ['src/cart.laws.ts::t', 'src/cart.ts::total']);
  assert.ok(ids(4, 33).includes('src/util/index.ts::helper'));
  assert.deepEqual(functionIdsFor({ rel: 'a.ts', text: 'x', line: 0, character: 5, exists }).word, null);
  assert.equal(wordAt('const price = 1', 8).word, 'price');
});

test('the Laws view tree: failing first, then the rest, with the file and the age', () => {
  const records = [
    { file: 'b.laws.ts', name: 'p', status: 'proved' },
    { file: 'a.laws.ts', name: 'f', status: 'failed', counterexample: '[1]' },
    { file: 'a.ts', name: 'lonely', status: 'uncovered', line: 3 },
    { file: 'a.laws.ts', name: 'o', status: 'open' },
  ];
  const tree = buildTree(records, { ranAt: new Map([['a.laws.ts::f', 0]]), now: 120_000, paramsOf: () => ['x'] });
  assert.deepEqual(
    tree.map((g) => g.label),
    ['Failing (1)', 'Open (1)', 'Uncovered functions (1)', 'Proved (1)'],
  );
  assert.equal(tree[0].children[0].description, 'a.laws.ts · 2m ago');
  assert.match(tree[0].children[0].tooltip, /counterexample x = 1/);
  assert.deepEqual(buildTree(null, { ranAt: new Map(), now: 0, paramsOf: () => [] }), []);
});

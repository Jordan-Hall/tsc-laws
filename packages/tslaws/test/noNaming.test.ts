// Laws without naming conventions, end to end: the level comes from imports, the lock stays strict for every laws file
// in the tree, and proposals live outside the tree. Needs TSC_LAWS_BIN (the compiler); browser cases also need Chrome.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { readManifest } from '../dist/compile.js';
import { readConfig } from '../dist/coverage.js';
import { lockLevels } from '../dist/lawKinds.js';
import { writeLock } from '../dist/lock.js';
import { addProposal } from '../dist/proposals.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-nonaming-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

function hasBrowser(): boolean {
  if (process.env.TSLAWS_BROWSER !== undefined && process.env.TSLAWS_BROWSER !== '') return true;
  const bases = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA];
  return (
    bases.some(
      (b) =>
        b !== undefined &&
        (existsSync(join(b, 'Google/Chrome/Application/chrome.exe')) ||
          existsSync(join(b, 'Microsoft/Edge/Application/msedge.exe'))),
    ) ||
    existsSync('/Applications/Google Chrome.app') ||
    ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].some(existsSync)
  );
}

function project(name: string, files: Record<string, string>): string {
  const cwd = join(root, name);
  // These cases are about levels from imports, which is opt-in.
  const base = files['tslaws.json'] === undefined ? {} : (JSON.parse(files['tslaws.json']) as Record<string, unknown>);
  files = { ...files, 'tslaws.json': JSON.stringify({ levels: 'imports', ...base }) };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  }
  return cwd;
}

function options(cwd: string, files: string[]): CheckOptions {
  return {
    files,
    cwd,
    runs: 30,
    compiler: compiler!,
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: false,
    bound: 4,
    proofTimeoutMs: 5000,
    propertyTimeoutMs: 20000,
  };
}

const accept = (opts: CheckOptions): void => {
  const laws = readManifest(opts.compiler, opts.files, opts.cwd);
  writeLock(opts.lockFile, laws, [], lockLevels(opts.cwd, laws, readConfig(opts.cwd).levels ?? 'names'));
};

function byName(results: LawResult[], name: string): LawResult {
  const found = results.find((r) => r.name === name);
  assert.ok(found, `no result for ${name}: ${JSON.stringify(results)}`);
  return found;
}

const counter = [
  'export function createCounter(el: HTMLElement): { button: HTMLButtonElement; label: HTMLElement } {',
  "  const label = document.createElement('span');",
  "  const button = document.createElement('button');",
  '  let n = 0;',
  "  label.textContent = '0';",
  "  button.addEventListener('click', () => { n += 1; label.textContent = String(n); });",
  '  el.append(label, button);',
  '  return { button, label };',
  '}',
  '',
].join('\n');

describe('laws files without naming conventions', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  it('check a Node law in a file with a laws glob name, and refuse it until it is accepted', async () => {
    const cwd = project('glob', {
      'tslaws.json': JSON.stringify({ laws: ['specs/**/*.ts'] }),
      'src/add.ts': 'export const add = (a: number, b: number): number => a + b;\n',
      'specs/add.ts':
        "import { add } from '../src/add';\nexport law commutes(a: number, b: number) => add(a, b) === add(b, a);\n",
    });
    const opts = options(cwd, ['specs/add.ts']);
    const before = await check(opts, true);
    assert.equal(byName(before.results, 'commutes').status, 'tampered');
    assert.equal(before.ok, false);
    accept(opts);
    const after = await check(opts, true);
    assert.equal(byName(after.results, 'commutes').status, 'proved');
    assert.equal(after.ok, true);
  });

  it('fail check for a changed or removed law in such a file, as for any laws file', async () => {
    const cwd = project('strict', {
      'tslaws.json': JSON.stringify({ laws: ['specs/**/*.ts'] }),
      'specs/a.ts': 'export law one(a: number) => a === a;\nexport law two(a: number) => a + 0 === a;\n',
    });
    const opts = options(cwd, ['specs/a.ts']);
    accept(opts);
    writeFileSync(join(cwd, 'specs/a.ts'), 'export law one(a: number) => a === a || a !== a;\n');
    const report = await check(opts, true);
    assert.equal(byName(report.results, 'one').status, 'tampered');
    assert.match(byName(report.results, 'one').message ?? '', /changed since the lock/);
    assert.equal(byName(report.results, 'two').status, 'tampered');
    assert.match(byName(report.results, 'two').message ?? '', /removed/);
    assert.equal(report.ok, false);
  });

  it(
    'run a plain-named file in the browser because a helper it imports uses the browser API',
    { skip: hasBrowser() ? false : 'needs a browser' },
    async () => {
      const cwd = project('helper', {
        'src/ui.ts': counter,
        'src/dom-helper.ts': [
          "import { click, mount } from 'tslaws/browser';",
          "import { createCounter } from './ui';",
          'export function clicks(n: number): string {',
          '  const { button, label } = createCounter(mount());',
          '  for (let i = 0; i < n; i++) click(button);',
          '  return label.textContent ?? "";',
          '}',
          '',
        ].join('\n'),
        'src/counter.laws.ts': [
          "import type { int } from 'tslaws';",
          "import { assume } from 'tslaws';",
          "import { clicks } from './dom-helper';",
          'export law countsClicks(n: int) {',
          '  assume(n >= 0 && n <= 4);',
          '  return clicks(n) === String(n);',
          '}',
          '',
        ].join('\n'),
      });
      const opts = options(cwd, ['src/counter.laws.ts']);
      accept(opts);
      const report = await check(opts, true);
      const r = byName(report.results, 'countsClicks');
      assert.equal(r.status, 'tested', JSON.stringify(r));
      assert.equal(r.method, 'browser');
      assert.deepEqual(report.notices, []);
    },
  );

  it(
    'still run a .browser.laws.ts file that imports nothing from the browser API, and say so once',
    { skip: hasBrowser() ? false : 'needs a browser' },
    async () => {
      const cwd = project('suffix-only', {
        'src/ui.ts': counter,
        'src/ui.browser.laws.ts': [
          "import { createCounter } from './ui';",
          'export law startsAtZero(n: number) {',
          '  const host = document.createElement("div");',
          '  document.body.append(host);',
          '  const { label } = createCounter(host);',
          '  return label.textContent === "0";',
          '}',
          '',
        ].join('\n'),
      });
      const opts = options(cwd, ['src/ui.browser.laws.ts']);
      accept(opts);
      const report = await check(opts, true);
      assert.equal(byName(report.results, 'startsAtZero').method, 'browser');
      assert.equal(byName(report.results, 'startsAtZero').status, 'tested');
      assert.equal(report.notices.length, 1);
      assert.match(report.notices[0]!, /name says browser, but nothing it imports is the browser law API/);
    },
  );

  it('refuse a file that reaches both levels through its helpers', async () => {
    const cwd = project('both', {
      'src/a.laws.ts':
        "import { r } from './h';\nimport { open } from 'tslaws/e2e';\nexport law mixed(n: number) { return r(n) === n; }\n",
      'src/h.ts': "import { mount } from 'tslaws/browser';\nexport const r = (n: number): number => (mount(), n);\n",
    });
    const opts = options(cwd, ['src/a.laws.ts']);
    accept(opts);
    const r = byName((await check(opts, true)).results, 'mixed');
    assert.equal(r.status, 'error', JSON.stringify(r));
    assert.match(r.message ?? '', /either component level \(tslaws\/browser\) or end-to-end \(tslaws\/e2e\), not both/);
    assert.match(r.message ?? '', /browser API reached through src\/h\.ts/);
  });

  it('run a proposal from .tslaws/proposals with no lock, and count nothing for coverage', async () => {
    const cwd = project('proposal', {
      'tslaws.json': JSON.stringify({ cover: ['src/**/*.ts', '!src/**/*.laws.ts'] }),
      'src/add.ts':
        'export const add = (a: number, b: number): number => a + b;\nexport const twice = (a: number): number => a * 2;\n',
      'src/add.laws.ts':
        "import { add } from './add';\nexport law commutes(a: number, b: number) => add(a, b) === add(b, a);\n",
    });
    const tree = options(cwd, ['src/add.laws.ts']);
    accept(tree);
    // `twice` is reached by no accepted law, so the tree is uncovered.
    const before = await check(tree, true);
    assert.equal(byName(before.results, 'twice').status, 'uncovered');
    // A proposal that reaches it does not change that, and it needs no lock.
    const written = addProposal(
      cwd,
      'twice.ts',
      "import { twice } from './src/add';\nexport law twiceDoubles(a: number) => twice(a) === a + a;\n",
    );
    assert.equal(written.file, '.tslaws/proposals/twice.ts');
    const proposed = await check(options(cwd, [written.file]), false);
    assert.equal(byName(proposed.results, 'twiceDoubles').status, 'proved', JSON.stringify(proposed.results));
    assert.equal(
      proposed.results.some((r) => r.status === 'uncovered' || r.status === 'tampered'),
      false,
    );
    assert.equal(proposed.ok, true);
    const after = await check(tree, true);
    assert.equal(byName(after.results, 'twice').status, 'uncovered');
    assert.equal(after.ok, false);
    // Checked as if it were part of the tree, the same file is refused: it is not in the lock.
    const strict = await check(options(cwd, [written.file]), true);
    assert.equal(byName(strict.results, 'twiceDoubles').status, 'tampered');
  });

  it(
    'run a proposal at the level its imports give, with project imports resolving',
    { skip: hasBrowser() ? false : 'needs a browser' },
    async () => {
      const cwd = project('proposal-browser', { 'src/ui.ts': counter });
      const written = addProposal(
        cwd,
        'ui.ts',
        [
          "import { assume } from 'tslaws';",
          "import { click, mount } from 'tslaws/browser';",
          "import { createCounter } from './src/ui';",
          'export law clicksCount(n: number) {',
          '  assume(n >= 0 && n <= 4 && Number.isInteger(n));',
          '  const { button, label } = createCounter(mount());',
          '  for (let i = 0; i < n; i++) click(button);',
          '  return label.textContent === String(n);',
          '}',
          '',
        ].join('\n'),
      );
      const report = await check(options(cwd, [written.file]), false);
      const r = byName(report.results, 'clicksCount');
      assert.equal(r.status, 'tested', JSON.stringify(r));
      assert.equal(r.method, 'browser');
    },
  );

  it('run an in-tree proposed name, without a notice', async () => {
    const cwd = project('in-tree-proposed', {
      'src/add.ts': 'export const add = (a: number, b: number): number => a + b;\n',
      'src/add.proposed.laws.ts':
        "import { add } from './add';\nexport law commutes(a: number, b: number) => add(a, b) === add(b, a);\n",
    });
    const report = await check(options(cwd, ['src/add.proposed.laws.ts']), false);
    assert.equal(byName(report.results, 'commutes').status, 'proved');
    assert.deepEqual(report.notices, []);
  });

  it('fail check for any unaccepted laws file of the tree, whatever its name', async () => {
    const cwd = project('unaccepted', {
      'src/add.ts': 'export const add = (a: number, b: number): number => a + b;\n',
      'src/add.laws.ts':
        "import { add } from './add';\nexport law commutes(a: number, b: number) => add(a, b) === add(b, a);\n",
    });
    const opts = options(cwd, ['src/add.laws.ts']);
    accept(opts);
    // A second laws file appears (a promoted proposal, or an agent's edit): the lock does not know it.
    writeFileSync(
      join(cwd, 'src/more.laws.ts'),
      "import { add } from './add';\nexport law zero(a: number) => add(a, 0) === a;\n",
    );
    const both = options(cwd, ['src/add.laws.ts', 'src/more.laws.ts']);
    const report = await check(both, true);
    assert.equal(byName(report.results, 'zero').status, 'tampered');
    assert.equal(report.ok, false);
  });
});

// `levels` in tslaws.json: names (the default) or imports (opt-in), and what each does to the level and the lock.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { parseConfig } from '../dist/coverage.js';
import { classifyLawFile } from '../dist/lawKinds.js';
import { compareLock, lawKey, lawHash, readLock, writeLock } from '../dist/lock.js';
import { listLawFiles } from '../dist/list.js';
import { watched } from '../dist/cli.js';
import { addProposal } from '../dist/proposals.js';
import type { ManifestLaw } from '../dist/types.js';

const root = mkdtempSync(join(tmpdir(), 'tslaws-levels-'));
after(() => rmSync(root, { recursive: true, force: true }));

const law = 'export law ok(n: number) { return n === n; }\n';
let count = 0;

function project(files: Record<string, string>): string {
  const cwd = join(root, `p${count++}`);
  mkdirSync(cwd, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  }
  return cwd;
}

const manifest = (file: string): ManifestLaw => ({
  file,
  name: 'ok',
  exported: true,
  proved: false,
  line: 1,
  params: [],
  body: '',
  text: 'law ok(n) { return n === n; }',
  problems: [],
});

describe('levels setting', () => {
  it('defaults to names and accepts names and imports', () => {
    assert.equal(parseConfig({}).levels, undefined);
    assert.equal(parseConfig({ levels: 'names' }).levels, 'names');
    assert.equal(parseConfig({ levels: 'imports' }).levels, 'imports');
  });

  it('rejects any other value with a clear error', () => {
    for (const bad of ['import', 'Names', true, 1, null, ['names']])
      assert.throws(() => parseConfig({ levels: bad }), /"levels" must be "names" or "imports"/);
  });
});

describe('classification by mode', () => {
  const files = {
    'src/helper.ts': "import { mount } from 'tslaws/browser';\nexport const m = mount;\n",
    'src/a.laws.ts': "import { m } from './helper';\n" + law,
    'src/b.browser.laws.ts': law,
    'src/c.e2e.laws.ts': law,
    'src/d.browser.laws.ts': "import { page } from 'tslaws/e2e';\n" + law,
    'src/both.laws.ts': "import 'tslaws/browser';\nimport 'tslaws/e2e';\n" + law,
  };

  it('takes the level from the file name by default, ignoring imports through helpers', () => {
    const cwd = project(files);
    assert.equal(classifyLawFile(cwd, 'src/a.laws.ts').kind, 'node');
    assert.equal(classifyLawFile(cwd, 'src/b.browser.laws.ts').kind, 'browser');
    assert.equal(classifyLawFile(cwd, 'src/c.e2e.laws.ts').kind, 'e2e');
    assert.equal(classifyLawFile(cwd, 'src/d.browser.laws.ts').kind, 'e2e');
    assert.deepEqual(classifyLawFile(cwd, 'src/b.browser.laws.ts').notices, []);
    assert.match(classifyLawFile(cwd, 'src/both.laws.ts').error ?? '', /not both/);
  });

  it('follows the import graph with imports, and still knows name-based files', () => {
    const cwd = project(files);
    assert.equal(classifyLawFile(cwd, 'src/a.laws.ts', 'imports').kind, 'browser');
    assert.equal(classifyLawFile(cwd, 'src/c.e2e.laws.ts', 'imports').kind, 'e2e');
    assert.equal(classifyLawFile(cwd, 'src/b.browser.laws.ts', 'imports').kind, 'browser');
  });

  it('lists with the configured mode', () => {
    const cwd = project({ ...files, 'tslaws.json': '{}' });
    assert.equal(listLawFiles(cwd).find((f) => f.file === 'src/a.laws.ts')?.kind, 'node');
    writeFileSync(join(cwd, 'tslaws.json'), JSON.stringify({ levels: 'imports' }));
    assert.equal(listLawFiles(cwd).find((f) => f.file === 'src/a.laws.ts')?.kind, 'browser');
  });
});

describe('the lock and levels', () => {
  it('writes no levels by name: the format is the one it always had, and verifies as before', () => {
    const cwd = project({});
    const lock = join(cwd, 'tsc-laws.lock');
    writeLock(lock, [manifest('src/a.laws.ts')], []);
    const raw = JSON.parse(readFileSync(lock, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(raw), ['version', 'laws', 'exempt']);
    assert.deepEqual(compareLock(readLock(lock)!.laws, [manifest('src/a.laws.ts')]), []);
  });

  it('records the resolved level by imports', () => {
    const cwd = project({});
    const lock = join(cwd, 'tsc-laws.lock');
    writeLock(lock, [manifest('src/a.laws.ts')], [], { 'src/a.laws.ts': 'node' });
    assert.deepEqual(readLock(lock)!.levels, { 'src/a.laws.ts': 'node' });
  });

  it('reports a changed level as tampered, as when a helper starts importing tslaws/browser', () => {
    const laws = [manifest('src/a.laws.ts')];
    const locked = { 'src/a.laws.ts': 'node' };
    assert.deepEqual(compareLock({ [lawKey('src/a.laws.ts', 'ok')]: lawHash(laws[0]!) }, laws, { locked, now: locked }), []);
    const v = compareLock({ [lawKey('src/a.laws.ts', 'ok')]: lawHash(laws[0]!) }, laws, {
      locked,
      now: { 'src/a.laws.ts': 'browser' },
    });
    assert.deepEqual(v, [{ key: 'src/a.laws.ts::ok', reason: 'level' }]);
  });

  it('treats a lock without levels as unaccepted once imports mode is on', () => {
    const laws = [manifest('src/a.laws.ts')];
    const v = compareLock({ [lawKey('src/a.laws.ts', 'ok')]: lawHash(laws[0]!) }, laws, {
      locked: undefined,
      now: { 'src/a.laws.ts': 'node' },
    });
    assert.equal(v[0]?.reason, 'level');
  });

  it('sees the helper-import attack through the classifier', () => {
    const cwd = project({
      'src/helper.ts': 'export const m = 1;\n',
      'src/a.laws.ts': "import { m } from './helper';\n" + law,
    });
    const before = classifyLawFile(cwd, 'src/a.laws.ts', 'imports').kind;
    writeFileSync(join(cwd, 'src/helper.ts'), "import 'tslaws/browser';\nexport const m = 1;\n");
    const after = classifyLawFile(cwd, 'src/a.laws.ts', 'imports').kind;
    assert.equal(before, 'node');
    assert.equal(after, 'browser');
    const laws = [manifest('src/a.laws.ts')];
    const key = { [lawKey('src/a.laws.ts', 'ok')]: lawHash(laws[0]!) };
    assert.equal(
      compareLock(key, laws, { locked: { 'src/a.laws.ts': before }, now: { 'src/a.laws.ts': after } })[0]?.reason,
      'level',
    );
    // By name nothing changes: the helper's import is not looked at and no levels are compared.
    assert.equal(classifyLawFile(cwd, 'src/a.laws.ts').kind, 'node');
    assert.deepEqual(compareLock(key, laws), []);
  });
});

describe('proposals directory', () => {
  it('adds .tslaws/proposals to an existing .gitignore on first propose, once', () => {
    const cwd = project({ '.gitignore': 'node_modules\n', 'src/x.ts': 'export {};\n' });
    addProposal(cwd, 'p.ts', law);
    addProposal(cwd, 'p.ts', 'export law other(n: number) { return n === n; }\n');
    assert.equal(readFileSync(join(cwd, '.gitignore'), 'utf8'), 'node_modules\n.tslaws/proposals\n');
  });
});

describe('watch set', () => {
  it('watches the proposals directory and in-tree proposals, not the rest of .tslaws', () => {
    assert.equal(watched('.tslaws/proposals/cart.ts'), true);
    assert.equal(watched('.tslaws\\proposals\\cart.ts'), true);
    assert.equal(watched('src/cart.proposed.laws.ts'), true);
    assert.equal(watched('.tslaws/out/x.ts'), false);
    assert.equal(watched('.tslaws/regressions/x.ts'), false);
    assert.equal(watched('node_modules/a/b.ts'), false);
    assert.equal(watched('.tslaws/proposals/readme.md'), false);
  });
});

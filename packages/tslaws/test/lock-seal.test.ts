// The lock covers what a law depends on: the helpers and top-level code of its file that it reaches, the project modules
// those import, and the run settings. Weakening any of them reads as tampered; an edit nothing reaches does not.
// Needs `npm run build` for dist/; uses the built-in compiler, so no TSC_LAWS_BIN.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { readManifest } from '../dist/compile.js';
import { lockFormat, readLock, writeLock } from '../dist/lock.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-seal-'));
let count = 0;

after(() => {
  rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

const files: Record<string, string> = {
  'src/limits.ts': 'export const limit = (n: number): boolean => n < 1000;\n',
  'src/unused.ts': 'export const nothing = 1;\n',
  'tslaws.json': '{"runs": 50, "bound": 4}\n',
  'src/f.laws.ts': [
    "import { arbitrary, fc, law } from 'tslaws';",
    "import { limit } from './limits';",
    "import { nothing } from './unused';",
    '',
    "arbitrary('Small', fc.integer({ min: 0, max: 100 }));",
    '',
    '// a helper only `usesHelper` calls',
    'const positive = (n: number): boolean => n * n >= 0;',
    '',
    '// nothing calls this one',
    'const unrelated = (n: number): number => n + nothing;',
    '',
    "law('usesHelper', (n: number) => positive(n));",
    "law('usesImport', (n: number) => limit(n) || !limit(n));",
    "law('plain', (n: number) => n === n);",
    "law('alsoPlain', (n: number) => n + 0 === n);",
    '',
  ].join('\n'),
};

interface Project {
  cwd: string;
  options: CheckOptions;
  /** Accepts the project as it is. */
  accept: () => void;
  edit: (file: string, from: string, to: string) => void;
  /** The status of each law after a check. */
  statuses: () => Promise<Record<string, LawResult['status']>>;
}

function project(extra: Record<string, string> = {}): Project {
  const cwd = join(root, `p${count++}`);
  for (const [file, text] of Object.entries({ ...files, ...extra })) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  }
  const options: CheckOptions = {
    files: ['src/f.laws.ts'],
    cwd,
    runs: 50,
    compiler: 'builtin',
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: true,
    bound: 4,
    proofTimeoutMs: 5000,
  };
  const accept = (): void => writeLock(options.lockFile, readManifest('builtin', options.files, cwd));
  accept();
  return {
    cwd,
    options,
    accept,
    edit(file, from, to) {
      const text = readFileSync(join(cwd, file), 'utf8');
      assert.ok(text.includes(from), `${file} has no ${from}`);
      writeFileSync(join(cwd, file), text.replace(from, to));
    },
    async statuses() {
      const { results } = await check(options, true);
      return Object.fromEntries(results.map((r) => [r.name, r.status]));
    },
  };
}

const tested = 'tested';

describe('the lock covers what a law depends on', () => {
  it('passes an untouched project', async () => {
    const p = project();
    assert.deepEqual(await p.statuses(), {
      usesHelper: tested,
      usesImport: tested,
      plain: tested,
      alsoPlain: tested,
    });
  });

  it('tampers a law whose helper was weakened, and no other', async () => {
    const p = project();
    p.edit('src/f.laws.ts', 'n * n >= 0', 'true');
    assert.deepEqual(await p.statuses(), {
      usesHelper: 'tampered',
      usesImport: tested,
      plain: tested,
      alsoPlain: tested,
    });
  });

  it('tampers every law when a generator or other top-level code of the file changed', async () => {
    const p = project();
    p.edit('src/f.laws.ts', 'max: 100', 'max: 1');
    assert.deepEqual(Object.values(await p.statuses()), ['tampered', 'tampered', 'tampered', 'tampered']);
  });

  it('tampers the laws that reach an imported module that changed', async () => {
    const p = project();
    p.edit('src/limits.ts', 'n < 1000', 'true');
    const status = await p.statuses();
    assert.equal(status.usesImport, 'tampered');
    assert.equal(status.usesHelper, tested);
    assert.equal(status.plain, tested);
  });

  it('follows the imports of an imported module', async () => {
    const p = project({
      'src/limits.ts': "import { floor } from './floor';\nexport const limit = (n: number): boolean => n < floor;\n",
      'src/floor.ts': 'export const floor = 1000;\n',
    });
    p.edit('src/floor.ts', '1000', '1');
    assert.equal((await p.statuses()).usesImport, 'tampered');
  });

  it('ignores edits that reach no law: comments, layout, a helper nobody calls, an unused import, another law', async () => {
    const p = project();
    p.edit('src/f.laws.ts', '// nothing calls this one', '// reworded');
    p.edit(
      'src/f.laws.ts',
      'const positive = (n: number): boolean => n * n >= 0;',
      'const positive = (n: number): boolean =>\n  n * n >= 0;',
    );
    p.edit('src/f.laws.ts', 'n + nothing', 'n + nothing + 1');
    p.edit('src/unused.ts', 'export const nothing = 1;', 'export const nothing = 2;');
    p.edit('src/f.laws.ts', 'n === n', 'n * 2 === n + n');
    assert.deepEqual(await p.statuses(), {
      usesHelper: tested,
      usesImport: tested,
      plain: 'tampered',
      alsoPlain: tested,
    });
  });

  it('tampers a law when a run setting is lowered', async () => {
    for (const [from, to] of [
      ['"runs": 50', '"runs": 1'],
      ['"bound": 4', '"bound": 2'],
    ] as const) {
      const p = project();
      p.edit('tslaws.json', from, to);
      assert.deepEqual(
        Object.values(await p.statuses()),
        ['tampered', 'tampered', 'tampered', 'tampered'],
        `${from} -> ${to}`,
      );
    }
  });

  it('tampers a law when the solvers or the compiler options change', async () => {
    for (const to of [
      '{"runs": 50, "bound": 4, "solvers": ["z3", "cvc5"]}',
      '{"runs": 50, "bound": 4, "compilerOptions": {"strict": false}}',
    ]) {
      const p = project();
      writeFileSync(join(p.cwd, 'tslaws.json'), to);
      assert.equal((await p.statuses()).plain, 'tampered', to);
    }
  });

  it('ignores a command line run count: one run is not the project', async () => {
    const p = project();
    p.options.runs = 5;
    assert.equal((await p.statuses()).plain, tested);
  });

  it('is not fooled by line endings', async () => {
    const p = project();
    const path = join(p.cwd, 'src/limits.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('\n', '\r\n'));
    assert.equal((await p.statuses()).usesImport, tested);
  });
});

describe('the lock format', () => {
  it('writes the current version', () => {
    const p = project();
    assert.equal(readLock(p.options.lockFile)?.version, lockFormat);
    assert.equal(JSON.parse(readFileSync(p.options.lockFile, 'utf8')).version, lockFormat);
  });

  it('fails an old-format lock with a message that says to accept again, and passes once accepted', async () => {
    for (const version of [undefined, 1]) {
      const p = project();
      const lock = JSON.parse(readFileSync(p.options.lockFile, 'utf8'));
      // The hashes of an old lock cover only each law's own text.
      for (const key of Object.keys(lock.laws)) lock.laws[key] = '0'.repeat(64);
      if (version === undefined) delete lock.version;
      else lock.version = version;
      writeFileSync(p.options.lockFile, JSON.stringify(lock, null, 2));
      const report = await check(p.options, true);
      assert.equal(report.ok, false);
      assert.equal(readLock(p.options.lockFile)?.version, version ?? 0);
      for (const result of report.results) {
        assert.equal(result.status, 'tampered');
        assert.match(result.message ?? '', /lock format upgraded/);
        assert.match(result.message ?? '', /tslaws accept/);
      }
      assert.ok(report.notices.some((n) => /lock format upgraded/.test(n)));
      p.accept();
      assert.equal((await check(p.options, true)).ok, true);
    }
  });
});

describe('levels', () => {
  it('tampers a lock that records levels when the project no longer resolves any', async () => {
    const p = project({ 'tslaws.json': '{"runs": 50, "bound": 4, "levels": "imports"}' });
    const levels = { 'src/f.laws.ts': 'node' };
    writeLock(p.options.lockFile, readManifest('builtin', p.options.files, p.cwd), [], levels);
    assert.equal((await p.statuses()).plain, tested);
    writeFileSync(join(p.cwd, 'tslaws.json'), '{"runs": 50, "bound": 4}');
    // The settings are the same, so only the levels section is behind the failure.
    const status = await p.statuses();
    assert.deepEqual(Object.values(status), ['tampered', 'tampered', 'tampered', 'tampered']);
  });
});

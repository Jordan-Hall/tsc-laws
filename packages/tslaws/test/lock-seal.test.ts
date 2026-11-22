// The lock covers what a law depends on: the helpers and top-level code of its file that it reaches, the project modules
// those import, and the run settings. Weakening any of them reads as tampered; an edit nothing reaches does not.
// Needs `npm run build` for dist/; uses the built-in compiler, so no TSC_LAWS_BIN.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  it('tampers every law of a file whose imported module changed: an import runs when the file loads', async () => {
    const p = project();
    p.edit('src/limits.ts', 'n < 1000', 'true');
    assert.deepEqual(Object.values(await p.statuses()), ['tampered', 'tampered', 'tampered', 'tampered']);
  });

  it('tampers every law when a module no law names anything from changed', async () => {
    const p = project();
    p.edit('src/unused.ts', 'export const nothing = 1;', 'export const nothing = 2;');
    assert.deepEqual(Object.values(await p.statuses()), ['tampered', 'tampered', 'tampered', 'tampered']);
  });

  it('follows the imports of an imported module', async () => {
    const p = project({
      'src/limits.ts': "import { floor } from './floor';\nexport const limit = (n: number): boolean => n < floor;\n",
      'src/floor.ts': 'export const floor = 1000;\n',
    });
    p.edit('src/floor.ts', '1000', '1');
    assert.deepEqual(Object.values(await p.statuses()), ['tampered', 'tampered', 'tampered', 'tampered']);
  });

  it('ignores edits that reach no law: comments, layout, a helper nobody calls, another law', async () => {
    const p = project();
    p.edit('src/f.laws.ts', '// nothing calls this one', '// reworded');
    p.edit(
      'src/f.laws.ts',
      'const positive = (n: number): boolean => n * n >= 0;',
      'const positive = (n: number): boolean =>\n  n * n >= 0;',
    );
    p.edit('src/f.laws.ts', 'n + nothing', 'n + nothing + 1');
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

  it('in a partial run, fails the named file only: a law outside it is neither removed nor tampered', async () => {
    const p = project({
      'src/g.laws.ts': "import { law } from 'tslaws';\nlaw('other', (n: number) => n === n);\n",
    });
    const both = ['src/f.laws.ts', 'src/g.laws.ts'];
    writeLock(p.options.lockFile, readManifest('builtin', both, p.cwd));
    const lock = JSON.parse(readFileSync(p.options.lockFile, 'utf8'));
    for (const key of Object.keys(lock.laws)) lock.laws[key] = '0'.repeat(64);
    delete lock.version;
    writeFileSync(p.options.lockFile, JSON.stringify(lock, null, 2));

    const { results } = await check({ ...p.options, partial: true }, true);
    assert.deepEqual([...new Set(results.map((r) => r.file))], ['src/f.laws.ts']);
    for (const result of results) {
      assert.equal(result.status, 'tampered');
      assert.match(result.message ?? '', /lock format upgraded/);
    }
    assert.ok(!results.some((r) => /removed/.test(r.message ?? '')));
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

/** The seal of each law of the project as it stands, read without running anything. */
function seals(p: Project): Record<string, string | undefined> {
  return Object.fromEntries(readManifest('builtin', p.options.files, p.cwd).map((law) => [law.name, law.seal]));
}

/** Whether the seals are the same after `edit`. */
function sameSeals(p: Project, edit: () => void): boolean {
  const before = seals(p);
  edit();
  return JSON.stringify(before) === JSON.stringify(seals(p));
}

describe('what a law reaches through the code that runs when its file loads', () => {
  const withRange = files['src/f.laws.ts']!.replace(
    "arbitrary('Small', fc.integer({ min: 0, max: 100 }));",
    "const range = { min: 0, max: 100 };\narbitrary('Small', fc.integer(range));",
  );

  it('seals a declaration only the top-level code references', async () => {
    const p = project({ 'src/f.laws.ts': withRange });
    p.edit('src/f.laws.ts', 'max: 100', 'max: 1');
    assert.deepEqual(Object.values(await p.statuses()), ['tampered', 'tampered', 'tampered', 'tampered']);
  });

  it('seals a declaration reached only from another declaration the top-level code references', () => {
    const p = project({
      'src/f.laws.ts': withRange
        .replace('const range = ', 'const top = 100;\nconst range = ')
        .replace('max: 100', 'max: top'),
    });
    assert.equal(
      sameSeals(p, () => p.edit('src/f.laws.ts', 'top = 100', 'top = 1')),
      false,
    );
  });

  it('seals a declaration that runs code when the file loads, though no law names it', () => {
    const p = project();
    p.edit('src/f.laws.ts', '// nothing calls this one', 'const setup = fc.constant(1);');
    assert.equal(
      sameSeals(p, () => p.edit('src/f.laws.ts', 'fc.constant(1)', 'fc.constant(2)')),
      false,
    );
  });

  // Each of these runs code of its own when the file loads, or when a later statement touches the value.
  for (const [name, init] of [
    ['a getter read', 'config.value'],
    ['a coercing binary operator', 'box + 1'],
    ['a coercing unary operator', '-box'],
    ['a template expression', '`${box}`'],
    ['an object literal with a method', '{ valueOf() { return 1; } }'],
    ['an object literal with an accessor', '{ get value() { return 1; } }'],
    ['a spread', '{ ...box }'],
  ] as const) {
    it(`seals a declaration whose initializer is ${name}, though no law names it`, () => {
      const p = project();
      p.edit(
        'src/f.laws.ts',
        '// nothing calls this one',
        `const config = { value: 1 };\nconst box = {};\nconst trap = ${init};`,
      );
      assert.equal(
        sameSeals(p, () => p.edit('src/f.laws.ts', 'const trap = ', 'const trap = 0 || ')),
        false,
      );
    });
  }

  it('does not seal a declaration of plain literals no law names', () => {
    const p = project();
    p.edit('src/f.laws.ts', '// nothing calls this one', 'const plain = { a: 1, b: [2, 3] };');
    assert.equal(
      sameSeals(p, () => p.edit('src/f.laws.ts', 'b: [2, 3]', 'b: [2, 4]')),
      true,
    );
  });
});

describe('what a law reaches through its imports', () => {
  const importing = (specifier: string): string => `import '${specifier}';\n${files['src/f.laws.ts']}`;

  it('digests the code behind a declaration file, and the declaration file', () => {
    const p = project({
      'src/lib.d.ts': 'export declare const lib: number;\n',
      'src/lib.js': 'export const lib = 1;\n',
      'src/f.laws.ts': importing('./lib'),
    });
    assert.equal(
      sameSeals(p, () => writeFileSync(join(p.cwd, 'src/lib.js'), 'export const lib = 2;\n')),
      false,
    );
    assert.equal(
      sameSeals(p, () => writeFileSync(join(p.cwd, 'src/lib.d.ts'), 'export declare const lib: string;\n')),
      false,
    );
  });

  it('digests a module outside the project', () => {
    const p = project({ 'src/f.laws.ts': importing('../../shared/x') });
    mkdirSync(join(p.cwd, '..', 'shared'), { recursive: true });
    const shared = join(p.cwd, '..', 'shared', 'x.ts');
    writeFileSync(shared, 'export const x = 1;\n');
    assert.equal(
      sameSeals(p, () => writeFileSync(shared, 'export const x = 2;\n')),
      false,
    );
  });

  it('digests the target of a symlink, not the link', (t) => {
    const p = project({ 'src/f.laws.ts': importing('./linked') });
    const target = join(p.cwd, '..', `target${count}.ts`);
    writeFileSync(target, 'export const y = 1;\n');
    try {
      symlinkSync(target, join(p.cwd, 'src', 'linked.ts'));
    } catch {
      t.skip('cannot create a symlink here');
      return;
    }
    assert.equal(
      sameSeals(p, () => writeFileSync(target, 'export const y = 2;\n')),
      false,
    );
  });

  it('records a registry package by name and version', () => {
    const p = project({
      'src/f.laws.ts': importing('registry-thing'),
      'node_modules/registry-thing/package.json': '{"name":"registry-thing","version":"1.0.0","main":"index.js"}',
      'node_modules/registry-thing/index.js': 'module.exports = 1;\n',
    });
    const manifest = join(p.cwd, 'node_modules/registry-thing/package.json');
    assert.equal(
      sameSeals(p, () => writeFileSync(manifest, '{"name":"registry-thing","version":"1.0.1","main":"index.js"}')),
      false,
    );
  });

  it('records a builtin as such only when nothing else answers to its name', () => {
    const p = project({ 'src/f.laws.ts': importing('fs') });
    assert.equal(
      sameSeals(p, () => p.edit('src/f.laws.ts', "'fs'", "'node:fs'")),
      false,
    );
  });

  it('digests a package that shadows a builtin name, and a file that does', () => {
    const p = project({
      'src/f.laws.ts': importing('fs'),
      'node_modules/fs/package.json': '{"name":"fs","version":"1.0.0","main":"index.js"}',
      'node_modules/fs/index.js': 'module.exports = 1;\n',
    });
    assert.equal(
      sameSeals(p, () =>
        writeFileSync(join(p.cwd, 'node_modules/fs/package.json'), '{"name":"fs","version":"1.0.1","main":"index.js"}'),
      ),
      false,
    );
    const q = project({
      'src/f.laws.ts': importing('fs'),
      'src/fs.ts': 'export const x = 1;\n',
      'tsconfig.json': '{"compilerOptions":{"baseUrl":"src"}}\n',
    });
    assert.equal(
      sameSeals(q, () => writeFileSync(join(q.cwd, 'src/fs.ts'), 'export const x = 2;\n')),
      false,
    );
  });

  it('records a specifier that resolves to nothing, as written', () => {
    const p = project({ 'src/f.laws.ts': importing('ghost-one') });
    assert.equal(
      sameSeals(p, () => p.edit('src/f.laws.ts', 'ghost-one', 'ghost-two')),
      false,
    );
  });

  it('digests an asset TypeScript does not resolve', () => {
    const p = project({ 'src/f.laws.ts': importing('./style.css'), 'src/style.css': 'a {}\n' });
    assert.equal(
      sameSeals(p, () => writeFileSync(join(p.cwd, 'src/style.css'), 'b {}\n')),
      false,
    );
  });
});

describe('what a law reaches through tslaws.json', () => {
  const edits: [string, string][] = [
    ['cover', '{"runs": 50, "bound": 4, "cover": ["src/**"]}'],
    ['env', '{"runs": 50, "bound": 4, "env": {"MODE": "production"}}'],
    ['e2e', '{"runs": 50, "bound": 4, "e2e": {"runs": 1}}'],
    ['laws', '{"runs": 50, "bound": 4, "laws": ["src/**/*.spec.ts"]}'],
    ['tsconfig', '{"runs": 50, "bound": 4, "tsconfig": false}'],
    ['certify', '{"runs": 50, "bound": 4, "certify": true}'],
    ['proofTimeoutMs', '{"runs": 50, "bound": 4, "proofTimeoutMs": 1}'],
  ];
  for (const [key, text] of edits)
    it(`seals ${key}`, () => {
      const p = project();
      assert.equal(
        sameSeals(p, () => writeFileSync(join(p.cwd, 'tslaws.json'), text)),
        false,
      );
    });

  it('does not seal the settings that run no law: github, security, levels', () => {
    const p = project();
    assert.equal(
      sameSeals(p, () =>
        writeFileSync(
          join(p.cwd, 'tslaws.json'),
          '{"runs": 50, "bound": 4, "github": {"local": true}, "security": {"offline": true}, "levels": "imports"}',
        ),
      ),
      true,
    );
  });

  it('treats a default written down as no change', () => {
    const p = project();
    assert.equal(
      sameSeals(p, () =>
        writeFileSync(join(p.cwd, 'tslaws.json'), '{"runs": 50, "bound": 4, "solvers": ["z3"], "certify": false}'),
      ),
      true,
    );
  });

  it('digests the plugin files of bundlerPlugins', () => {
    const p = project({
      'tools/plugin.mjs': 'export default { name: "a", setup() {} };\n',
      'tslaws.json': '{"runs": 50, "bound": 4, "bundlerPlugins": ["./tools/plugin.mjs"]}',
    });
    assert.equal(
      sameSeals(p, () => writeFileSync(join(p.cwd, 'tools/plugin.mjs'), 'export default { name: "b", setup() {} };\n')),
      false,
    );
  });

  it('digests the tsconfig it resolves with', () => {
    const p = project({ 'tsconfig.json': '{"compilerOptions": {"paths": {"@a/*": ["./src/*"]}}}\n' });
    assert.equal(
      sameSeals(p, () =>
        writeFileSync(join(p.cwd, 'tsconfig.json'), '{"compilerOptions": {"paths": {"@a/*": ["./other/*"]}}}\n'),
      ),
      false,
    );
  });
});

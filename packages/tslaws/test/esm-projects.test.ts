// Laws in ES-module projects: `"type": "module"`, NodeNext and Bundler resolution, `.mts` files, `.js` specifiers that
// name `.ts` files, `import.meta`, and the limit that top-level await has. A CommonJS project keeps working, and the
// package's own files are ES modules. Each case writes a small project and checks it with the built-in compiler (and
// with the native one when TSC_LAWS_BIN is set); needs `npm run build` for dist/.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readManifest } from '../dist/compile.js';
import { check } from '../dist/check.js';
import { writeLock } from '../dist/lock.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
// Inside the package so `tslaws` and `fast-check` resolve through its node_modules.
const root = mkdtempSync(join(packageRoot, '.tmp-esm-'));
const native = process.env.TSC_LAWS_BIN;

after(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  // Z3's worker threads keep the test process alive.
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

let counter = 0;
function project(files: Record<string, string>): string {
  const dir = join(root, `p${(counter += 1)}`);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

async function run(cwd: string, files: string[], compiler: string): Promise<LawResult[]> {
  const lockFile = join(cwd, 'tsc-laws.lock');
  const opts: CheckOptions = {
    files,
    cwd,
    runs: 20,
    compiler,
    lockFile,
    noProve: true,
    bound: 4,
    proofTimeoutMs: 5000,
    propertyTimeoutMs: 20000,
  };
  writeLock(lockFile, readManifest(compiler, files, cwd));
  return (await check(opts, true)).results;
}

const byName = (results: LawResult[], name: string): LawResult => {
  const found = results.find((r) => r.name === name);
  assert.ok(found, `no result for ${name}: ${JSON.stringify(results)}`);
  return found;
};

const compilers: [string, string][] = [['builtin', 'builtin']];
if (native !== undefined) compilers.push(['native', native]);

const tsconfig = (compilerOptions: Record<string, unknown>): string =>
  JSON.stringify({
    compilerOptions: { target: 'es2022', strict: true, skipLibCheck: true, ...compilerOptions },
    include: ['src'],
  });
const nodenext = tsconfig({ module: 'nodenext', moduleResolution: 'nodenext' });

const addLaw = [
  "import { law } from 'tslaws';",
  "import { add } from './math';",
  "law('add commutes', (a: number, b: number) => add(a, b) === add(b, a));",
  '',
].join('\n');
const addSource = 'export const add = (a: number, b: number): number => a + b;\n';

const sources = {
  'src/math.ts': [
    addSource.trimEnd(),
    'export const sourceUrl = (): string => import.meta.url;',
    'export const sourceDir = (): string => import.meta.dirname;',
    'export const sourceFile = (): string => import.meta.filename;',
    '',
  ].join('\n'),
  'src/double.mts': 'export const double = (n: number): number => n * 2;\n',
  'src/a.laws.ts': [
    "import { law } from 'tslaws';",
    "import { add, sourceDir, sourceFile, sourceUrl } from './math.js';",
    "import { double } from './double.mjs';",
    "law('add commutes', (a: number, b: number) => add(a, b) === add(b, a));",
    "law('an .mts module is reached by its .mjs specifier', (n: number) => double(n) === add(n, n));",
    "law('import.meta.url is the source file', (n: number) => sourceUrl().startsWith('file:') && sourceUrl().endsWith('/src/math.ts') && n === n);",
    "law('import.meta.dirname and filename are the source file', (n: number) => sourceFile().startsWith(sourceDir()) && sourceFile().endsWith('math.ts') && n === n);",
    '',
  ].join('\n'),
};

const expected = [
  'add commutes',
  'an .mts module is reached by its .mjs specifier',
  'import.meta.url is the source file',
  'import.meta.dirname and filename are the source file',
];

for (const [label, compiler] of compilers) {
  describe(`ES-module projects (${label} compiler)`, () => {
    it('runs laws in a "type": "module" project with NodeNext resolution', async () => {
      const cwd = project({
        'package.json': JSON.stringify({ name: 'esm-project', type: 'module' }),
        'tsconfig.json': nodenext,
        ...sources,
      });
      const results = await run(cwd, ['src/a.laws.ts'], compiler);
      for (const name of expected)
        assert.equal(byName(results, name).status, 'tested', JSON.stringify(byName(results, name)));
    });

    it('runs laws in a NodeNext project that is CommonJS by package type, importing an .mts module', async () => {
      const cwd = project({
        'package.json': JSON.stringify({ name: 'nodenext-project' }),
        'tsconfig.json': nodenext,
        ...sources,
      });
      const results = await run(cwd, ['src/a.laws.ts'], compiler);
      for (const name of expected)
        assert.equal(byName(results, name).status, 'tested', JSON.stringify(byName(results, name)));
    });

    it('runs laws in a Bundler-resolution project with extensionless imports', async () => {
      const cwd = project({
        'package.json': JSON.stringify({ name: 'bundler-project', type: 'module' }),
        'tsconfig.json': tsconfig({ module: 'esnext', moduleResolution: 'bundler' }),
        'src/math.ts': addSource,
        'src/a.laws.ts': addLaw,
      });
      const results = await run(cwd, ['src/a.laws.ts'], compiler);
      assert.equal(byName(results, 'add commutes').status, 'tested');
    });

    it('keeps running laws in a CommonJS project', async () => {
      const cwd = project({
        'package.json': JSON.stringify({ name: 'cjs-project', type: 'commonjs' }),
        'tsconfig.json': tsconfig({ module: 'commonjs', moduleResolution: 'node10' }),
        'src/math.ts': addSource,
        'src/a.laws.ts': addLaw,
      });
      const results = await run(cwd, ['src/a.laws.ts'], compiler);
      assert.equal(byName(results, 'add commutes').status, 'tested');
    });

    it('loads a package whose exports offer only an import condition, by its main entry and by a subpath', async () => {
      const cwd = project({
        'package.json': JSON.stringify({ name: 'import-only-project', type: 'module' }),
        'tsconfig.json': nodenext,
        'node_modules/import-only/package.json': JSON.stringify({
          name: 'import-only',
          version: '1.0.0',
          type: 'module',
          exports: {
            '.': { types: './index.d.ts', import: './index.js' },
            './server': { types: './server.d.ts', import: './server.js' },
          },
        }),
        'node_modules/import-only/index.js': 'export const main = (n) => n + 1;\n',
        'node_modules/import-only/index.d.ts': 'export declare const main: (n: number) => number;\n',
        'node_modules/import-only/server.js': 'export const server = (n) => n * 2;\n',
        'node_modules/import-only/server.d.ts': 'export declare const server: (n: number) => number;\n',
        'src/a.laws.ts': [
          "import { law } from 'tslaws';",
          "import { main } from 'import-only';",
          "import { server } from 'import-only/server';",
          "law('the main entry loads', (n: number) => main(n) === n + 1);",
          "law('the subpath loads', (n: number) => server(n) === n * 2);",
          '',
        ].join('\n'),
      });
      const results = await run(cwd, ['src/a.laws.ts'], compiler);
      for (const name of ['the main entry loads', 'the subpath loads'])
        assert.equal(byName(results, name).status, 'tested', JSON.stringify(byName(results, name)));
    });

    it('says what is unsupported, rather than crashing, for top-level await in a module a law imports', async () => {
      const cwd = project({
        'package.json': JSON.stringify({ name: 'tla-project', type: 'module' }),
        'tsconfig.json': nodenext,
        'src/tla.ts':
          'export const base = await Promise.resolve(10);\nexport const inc = (n: number): number => n + base;\n',
        'src/a.laws.ts': [
          "import { law } from 'tslaws';",
          "import { inc } from './tla.js';",
          "law('adds ten', (n: number) => inc(n) === n + 10);",
          '',
        ].join('\n'),
      });
      const results = await run(cwd, ['src/a.laws.ts'], compiler);
      const result = byName(results, 'adds ten');
      assert.equal(result.status, 'error');
      assert.match(result.message ?? '', /top-level await is not supported/);
      assert.match(result.message ?? '', /src\/tla\.js/);
    });
  });
}

describe('the package is ES-module first', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return files(full);
      return /\.[cm]?js$/.test(name) ? [full] : [];
    });

  it('is "type": "module", with an import condition on every JavaScript export', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    assert.equal(manifest.type, 'module');
    for (const [key, target] of Object.entries(manifest.exports as Record<string, unknown>)) {
      if (typeof target !== 'object' || target === null || !('default' in target)) continue;
      const conditions = target as Record<string, string>;
      assert.equal(conditions.import, conditions.default, key);
      assert.ok('types' in conditions, key);
    }
  });

  it('has no CommonJS in the bin, the hooks or the built files', () => {
    const found = ['bin', 'hooks', 'github', 'dist'].flatMap((dir) => files(join(packageRoot, dir)));
    assert.ok(found.length > 20);
    for (const file of found) {
      const text = readFileSync(file, 'utf8');
      assert.doesNotMatch(text, /^\s*(?:module\.)?exports(?:\.\w+)?\s*=[^=]|__dirname|__filename/m, file);
    }
  });
});

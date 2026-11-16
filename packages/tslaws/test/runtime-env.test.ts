// `import.meta.env` and extensionless imports in TypeScript dependencies, in every place a law runs.
// Each case writes a small project and checks it with the built-in compiler; needs `npm run build` for dist/.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build, lowerEmittedModules, readManifest } from '../dist/compile.js';
import { check } from '../dist/check.js';
import { parseConfig } from '../dist/coverage.js';
import { writeLock } from '../dist/lock.js';
import { importMetaEnvOf, installLoaderHooks, parseEnvConfig } from '../dist/runtimeEnv.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const here = dirname(fileURLToPath(import.meta.url));
// Inside the package so `tslaws` and `fast-check` resolve through its node_modules.
const root = mkdtempSync(join(here, '..', '.tmp-env-'));

after(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  // Z3's worker threads keep the test process alive.
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

function project(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

function options(cwd: string, files: string[], compiler = 'builtin'): CheckOptions {
  const opts: CheckOptions = {
    files,
    cwd,
    runs: 20,
    compiler,
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: true,
    bound: 4,
    proofTimeoutMs: 5000,
    propertyTimeoutMs: 20000,
  };
  writeLock(opts.lockFile, readManifest(compiler, files, cwd));
  return opts;
}

const byName = (results: LawResult[], name: string): LawResult => {
  const found = results.find((r) => r.name === name);
  assert.ok(found, `no result for ${name}: ${JSON.stringify(results)}`);
  return found;
};

const envSource = [
  'export const mode = (): string => import.meta.env.MODE;',
  'export const flag = (): string => String(import.meta.env.VITE_FLAG);',
  'export const server = (): boolean => import.meta.env.SSR === true && import.meta.env.DEV === true;',
  '',
].join('\n');

const modeLaw = [
  "import { law } from 'tslaws';",
  "import { mode } from './env';",
  "law('mode is test', () => mode() === 'test');",
  '',
].join('\n');

describe('import.meta.env', () => {
  it('is an object in laws run by a property worker, with the defaults and the tslaws.json env', async () => {
    const cwd = project('env', {
      'tslaws.json': JSON.stringify({ env: { VITE_FLAG: 'on' } }),
      'src/env.ts': envSource,
      'src/a.laws.ts': [
        "import { law } from 'tslaws';",
        "import { flag, mode, server } from './env';",
        "law('mode defaults to test', (n: number) => mode() === 'test' && n === n);",
        "law('the configured value is read', (n: number) => flag() === 'on' && n === n);",
        "law('a Node law is server side', (n: number) => server() && n === n);",
        '',
      ].join('\n'),
    });
    const { results } = await check(options(cwd, ['src/a.laws.ts']), true);
    for (const name of ['mode defaults to test', 'the configured value is read', 'a Node law is server side'])
      assert.equal(byName(results, name).status, 'tested', JSON.stringify(byName(results, name)));
  });

  it('compiles without a diagnostic when the project declares no ImportMeta.env', () => {
    const cwd = project('env-types', { 'src/env.ts': envSource, 'src/a.laws.ts': modeLaw });
    const built = build('builtin', ['src/a.laws.ts'], cwd);
    assert.equal(built.diagnostics, '');
    assert.equal(built.ok, true);
    assert.match(readFileSync(join(cwd, '.tslaws', 'out', 'src', 'env.js'), 'utf8'), /__tslawsImportMetaEnv\.MODE/);
  });

  it("keeps the project's own ImportMeta.env declaration instead of adding a second", () => {
    const cwd = project('env-own-types', {
      'src/env.d.ts': 'interface ImportMeta { readonly env: { readonly MODE: string; readonly VITE_ONLY: string } }\n',
      'src/env.ts': [
        '/// <reference path="./env.d.ts" />',
        'export const mode = (): string => import.meta.env.VITE_ONLY;',
        '',
      ].join('\n'),
      'src/a.laws.ts': modeLaw,
    });
    const built = build('builtin', ['src/a.laws.ts'], cwd);
    assert.equal(built.diagnostics, '');
  });

  it('reuses an unchanged build that needed the shipped declaration', () => {
    const cwd = project('env-cache', { 'src/env.ts': envSource, 'src/a.laws.ts': modeLaw });
    const first = build('builtin', ['src/a.laws.ts'], cwd);
    const second = build('builtin', ['src/a.laws.ts'], cwd);
    assert.equal(second.key, first.key);
    assert.equal(second.diagnostics, '');
  });

  it('is lowered in the output of the native compiler too', () => {
    const dir = join(root, 'emitted');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    // The runner writes this beside the output, so that `.js` is CommonJS whatever the project says.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
    writeFileSync(
      join(dir, 'sub', 'm.js'),
      'export const mode = import.meta.env.MODE;\nexport const kind = typeof import.meta;\n',
    );
    lowerEmittedModules(dir);
    assert.doesNotMatch(readFileSync(join(dir, 'sub', 'm.js'), 'utf8'), /import\.meta\.env/);
    (globalThis as Record<string, unknown>).__tslawsImportMetaEnv = { MODE: 'from-global' };
    assert.equal((createRequire(import.meta.url)(join(dir, 'sub', 'm.js')) as { mode: string }).mode, 'from-global');
  });

  it('merges process.env, the defaults and the configured entries, in a page without SSR', () => {
    const env = importMetaEnvOf({ MODE: 'staging', VITE_X: 'x', PROD: true }, 'browser', {
      HOME: '/h',
      MODE: 'ignored',
    });
    assert.deepEqual(env, {
      HOME: '/h',
      MODE: 'staging',
      DEV: true,
      PROD: true,
      SSR: false,
      BASE_URL: '/',
      VITE_X: 'x',
    });
    const node = importMetaEnvOf(undefined, 'node', { MODE: 'production', BASE_URL: '/app/' });
    assert.equal(node.MODE, 'production');
    assert.equal(node.BASE_URL, '/app/');
    assert.equal(node.SSR, true);
  });

  it('validates the env option of tslaws.json', () => {
    assert.deepEqual(parseConfig({ env: { A: 'a', DEV: false } }).env, { A: 'a', DEV: false });
    assert.throws(() => parseConfig({ env: ['A'] }), /"env" must be an object/);
    assert.throws(() => parseConfig({ env: { A: 1 } }), /"env.A" must be a string or a boolean/);
    assert.throws(() => parseEnvConfig(null), /"env" must be an object/);
  });
});

describe('TypeScript dependencies loaded by Node', () => {
  it('resolve extensionless relative imports and read import.meta.env', async () => {
    const cwd = project('esm-dep', {
      'tslaws.json': JSON.stringify({ env: { VITE_FLAG: 'dep' } }),
      // A workspace package: type module, exports TypeScript source, relative imports without an extension.
      'libs/esm-dep/package.json': JSON.stringify({
        name: 'esm-dep',
        type: 'module',
        exports: { '.': './src/index.ts' },
      }),
      'libs/esm-dep/src/index.ts': [
        "export * from './database';",
        "export { helper } from './util';",
        'export const depMode = (): string => `${import.meta.env.MODE}:${import.meta.env.VITE_FLAG}`;',
        '',
      ].join('\n'),
      'libs/esm-dep/src/database.ts': "export const table = (): string => 'users';\n",
      'libs/esm-dep/src/util/index.ts': 'export const helper = (n: number): number => n + 1;\n',
      'src/a.laws.ts': [
        "import { law } from 'tslaws';",
        "import { depMode, helper, table } from 'esm-dep';",
        "law('the dependency loads', (n: number) => table() === 'users' && helper(n) === n + 1);",
        "law('the dependency reads the environment', () => depMode() === 'test:dep');",
        '',
      ].join('\n'),
    });
    // Once its link is followed the package is outside node_modules, as a workspace member is.
    mkdirSync(join(cwd, 'node_modules'), { recursive: true });
    symlinkSync(join(cwd, 'libs', 'esm-dep'), join(cwd, 'node_modules', 'esm-dep'), 'junction');
    const { results } = await check(options(cwd, ['src/a.laws.ts']), true);
    for (const name of ['the dependency loads', 'the dependency reads the environment'])
      assert.equal(byName(results, name).status, 'tested', JSON.stringify(byName(results, name)));
  });

  it('install their hooks once, where Node has module.registerHooks', () => {
    assert.equal(installLoaderHooks(), installLoaderHooks());
  });
});

const hasBrowser =
  process.env.TSLAWS_BROWSER !== undefined
    ? existsSync(process.env.TSLAWS_BROWSER)
    : [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].some(
        (base) =>
          base !== undefined &&
          (existsSync(join(base, 'Google/Chrome/Application/chrome.exe')) ||
            existsSync(join(base, 'Microsoft/Edge/Application/msedge.exe'))),
      ) || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].some(existsSync);

describe('import.meta.env in a page', { skip: hasBrowser ? false : 'needs a browser' }, () => {
  it('is set before the law loads, is not server side and takes the tslaws.json env', async () => {
    const cwd = project('env-page', {
      'tslaws.json': JSON.stringify({ env: { VITE_FLAG: 'page' } }),
      'src/env.ts': envSource,
      'src/ui.browser.laws.ts': [
        "import { law } from 'tslaws';",
        "import { flag, mode, server } from './env';",
        "law('the page reads the environment', async () => mode() === 'test' && flag() === 'page' && !server());",
        '',
      ].join(String.fromCharCode(10)),
    });
    const { results } = await check(options(cwd, ['src/ui.browser.laws.ts']), true);
    const result = byName(results, 'the page reads the environment');
    assert.equal(result.status, 'tested', JSON.stringify(result));
    assert.equal(result.method, 'browser');
  });
});

describe(
  'import.meta.env with the tsc-laws compiler',
  { skip: process.env.TSC_LAWS_BIN === undefined ? 'set TSC_LAWS_BIN' : false },
  () => {
    it('compiles without TS1343 or TS2339, and the laws read the environment', async () => {
      const compiler = process.env.TSC_LAWS_BIN!;
      const cwd = project('env-native', {
        'tslaws.json': JSON.stringify({ env: { VITE_FLAG: 'native' } }),
        'src/env.ts': envSource,
        'src/a.laws.ts': [
          "import { flag, mode } from './env';",
          "export law modeIsTest(n: number) => mode() === 'test' && n === n;",
          "export law flagIsConfigured(n: number) => flag() === 'native' && n === n;",
          '',
        ].join(String.fromCharCode(10)),
      });
      const report = await check(options(cwd, ['src/a.laws.ts'], compiler), true);
      assert.equal(report.compileDiagnostics, '');
      for (const name of ['modeIsTest', 'flagIsConfigured'])
        assert.equal(byName(report.results, name).status, 'tested', JSON.stringify(byName(report.results, name)));
    });
  },
);

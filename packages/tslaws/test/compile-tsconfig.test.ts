// Laws compile and run with the package's tsconfig resolution: `paths`, `baseUrl`, `extends` through a package in
// node_modules, workspace packages that ship TypeScript source, and the `"tsconfig": false` opt-out.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { parseConfig } from '../dist/coverage.js';
import type { CheckOptions } from '../dist/types.js';

const nativeCompiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-tsconfig-'));
after(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

const json = (value: unknown): string => JSON.stringify(value);

/** Writes `files` under `root/name`; the project is `root/name/app`, so siblings can play workspace packages. */
function project(name: string, files: Record<string, string>, compiler = 'builtin'): CheckOptions {
  const base = join(root, name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, file)), { recursive: true });
    writeFileSync(join(base, file), text);
  }
  const cwd = join(base, 'app');
  return {
    files: ['a.laws.ts'],
    cwd,
    runs: 20,
    compiler,
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: true,
    bound: 4,
    proofTimeoutMs: 5000,
  };
}

const law = (specifier: string): string =>
  `import { law } from 'tslaws';\nimport { double } from '${specifier}';\nlaw('doubling adds', (n: number) => double(n) === n + n);\n`;
const double = 'export const double = (n: number): number => n * 2;\n';

async function run(options: CheckOptions): Promise<{ statuses: string[]; text: string; compiled: boolean }> {
  const report = await check(options, false);
  return {
    statuses: report.results.map((r) => r.status),
    text: report.compileDiagnostics + JSON.stringify(report.results),
    compiled: report.compileOk,
  };
}

describe('tsconfig resolution', () => {
  it('imports through paths, compiles and runs', async () => {
    const options = project('paths', {
      'app/tsconfig.json': json({ compilerOptions: { paths: { '@app/*': ['./lib/*'] } } }),
      'app/lib/x.ts': double,
      'app/a.laws.ts': law('@app/x'),
    });
    const { statuses, text, compiled } = await run(options);
    assert.equal(compiled, true, text);
    assert.deepEqual(statuses, ['tested'], text);
  });

  it('runs the aliased file when a paths entry shares its name with an installed package', async () => {
    const options = project('shadow', {
      'app/tsconfig.json': json({ compilerOptions: { paths: { dup: ['./lib/dup.ts'] } } }),
      'app/lib/dup.ts': double,
      // The installed package of the same name has a different answer; the type checker never looked at it.
      'app/node_modules/dup/package.json': json({ name: 'dup', main: 'index.js', types: 'index.d.ts' }),
      'app/node_modules/dup/index.js': 'exports.double = (n) => n * 3;\n',
      'app/node_modules/dup/index.d.ts': 'export declare const double: (n: number) => number;\n',
      'app/a.laws.ts': law('dup'),
    });
    const { statuses, text, compiled } = await run(options);
    assert.equal(compiled, true, text);
    assert.deepEqual(statuses, ['tested'], text);
  });

  it('imports through baseUrl', async () => {
    const options = project('base', {
      'app/tsconfig.json': json({ compilerOptions: { baseUrl: './src' } }),
      'app/src/shared/x.ts': double,
      'app/a.laws.ts': law('shared/x'),
    });
    const { statuses, text } = await run(options);
    assert.deepEqual(statuses, ['tested'], text);
  });

  it('follows extends through a package in node_modules and rebases its paths', async () => {
    const options = project('extends', {
      // The base file is three directories below the project; its paths are relative to itself.
      'app/node_modules/@repo/config/base.json': json({
        compilerOptions: { paths: { '@app/*': ['../../../lib/*'] }, strict: true },
        include: ['never/**'],
      }),
      'app/tsconfig.json': json({ extends: '@repo/config/base.json', include: ['also-never'] }),
      'app/lib/x.ts': double,
      'app/a.laws.ts': law('@app/x'),
    });
    const { statuses, text } = await run(options);
    assert.deepEqual(statuses, ['tested'], text);
  });

  it('uses the file named by "tsconfig", relative to tslaws.json', async () => {
    const options = project('named', {
      'app/tslaws.json': json({ tsconfig: 'config/app.json' }),
      'app/config/app.json': json({ compilerOptions: { paths: { '@app/*': ['../lib/*'] } } }),
      'app/lib/x.ts': double,
      'app/a.laws.ts': law('@app/x'),
    });
    const { statuses, text } = await run(options);
    assert.deepEqual(statuses, ['tested'], text);
  });

  it('reports a named tsconfig that does not exist', async () => {
    const options = project('missing', {
      'app/tslaws.json': json({ tsconfig: 'nope.json' }),
      'app/a.laws.ts': law('./lib/x'),
      'app/lib/x.ts': double,
    });
    await assert.rejects(run(options), /"tsconfig": no such file: nope\.json/);
  });

  it('type-checks and runs a workspace package that exports TypeScript source', async () => {
    const options = project('workspace', {
      'app/tsconfig.json': json({ compilerOptions: {} }),
      'packages/util/package.json': json({ name: '@ws/util', version: '1.0.0', exports: { '.': './src/index.ts' } }),
      'packages/util/src/index.ts':
        'export enum Factor { Two = 2 }\nexport const double = (n: number): number => n * Factor.Two;\n',
      'app/a.laws.ts': law('@ws/util'),
    });
    mkdirSync(join(options.cwd, 'node_modules', '@ws'), { recursive: true });
    symlinkSync(
      join(root, 'workspace', 'packages', 'util'),
      join(options.cwd, 'node_modules', '@ws', 'util'),
      'junction',
    );
    const { statuses, text, compiled } = await run(options);
    assert.equal(compiled, true, text);
    assert.deepEqual(statuses, ['tested'], text);
  });

  it('leaves the aliases unresolved with "tsconfig": false', async () => {
    const options = project('optout', {
      'app/tslaws.json': json({ tsconfig: false }),
      'app/tsconfig.json': json({ compilerOptions: { paths: { '@app/*': ['./lib/*'] } } }),
      'app/lib/x.ts': double,
      'app/a.laws.ts': law('@app/x'),
    });
    const { compiled, text } = await run(options);
    assert.equal(compiled, false);
    assert.match(text, /Cannot find module '@app\/x'/);
  });

  it('validates the setting', () => {
    assert.deepEqual(parseConfig({ tsconfig: false }), { tsconfig: false });
    assert.deepEqual(parseConfig({ tsconfig: 'a/tsconfig.json' }), { tsconfig: 'a/tsconfig.json' });
    assert.throws(() => parseConfig({ tsconfig: true }), /"tsconfig" must be a path to a tsconfig file or false/);
    assert.throws(() => parseConfig({ tsconfig: '' }), /"tsconfig" must be a path/);
  });

  it(
    'passes paths to the tsc-laws compiler',
    { skip: nativeCompiler === undefined ? 'set TSC_LAWS_BIN' : false },
    async () => {
      const options = project(
        'native',
        {
          'app/tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['./lib/*'] } } }),
          'app/lib/x.ts': double,
          'app/a.laws.ts': `import { double } from '@app/x';\nexport law doubleIsEven(n: number) {\n  return double(n) === n + n;\n}\n`,
        },
        nativeCompiler,
      );
      const { statuses, text, compiled } = await run(options);
      assert.equal(compiled, true, text);
      assert.ok(statuses.length === 1 && statuses[0] !== 'error', text);
    },
  );

  it(
    'compiles a sibling package reached through paths with the tsc-laws compiler',
    { skip: nativeCompiler === undefined ? 'set TSC_LAWS_BIN' : false },
    async () => {
      const options = project(
        'native-sibling',
        {
          'app/tsconfig.json': json({ compilerOptions: { paths: { '@shared/*': ['../shared/src/*'] } } }),
          'shared/src/x.ts': double,
          'app/a.laws.ts': `import { double } from '@shared/x';\nexport law doubleIsEven(n: number) {\n  return double(n) === n + n;\n}\n`,
        },
        nativeCompiler,
      );
      const { statuses, text, compiled } = await run(options);
      assert.equal(compiled, true, text);
      assert.doesNotMatch(text, /TS6059/);
      assert.ok(statuses.length === 1 && statuses[0] !== 'error', text);
      // The output mirrors the tree from the common root: the project below it, the sibling beside it.
      const out = join(options.cwd as string, '.tslaws', 'out');
      assert.ok(existsSync(join(out, 'app', 'a.laws.js')), 'project output at its place under the root');
      assert.ok(existsSync(join(out, 'shared', 'src', 'x.js')), 'sibling output at its place under the root');
      assert.ok(existsSync(join(out, 'app', 'tslaws-runtime.json')), 'runtime file beside the project output');
    },
  );
});

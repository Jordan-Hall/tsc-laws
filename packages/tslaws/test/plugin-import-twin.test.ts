// A file a `bundlerPlugins` onLoad produces can import a project `.ts` module. The build compiles that module into
// `.tslaws/out`, so the import must reach that copy: the law and the template then share one module instance, and the
// sandbox, which serves only what was reviewed, never sees the source path.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readManifest } from '../dist/compile.js';
import { check } from '../dist/check.js';
import { writeLock } from '../dist/lock.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const here = dirname(fileURLToPath(import.meta.url));
// Inside the package so `tslaws` and `fast-check` resolve through its node_modules.
const root = mkdtempSync(join(here, '..', '.tmp-plugin-twin-'));

after(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

/** A fake format: `.view` files hold a message, and the module it becomes imports `../i18n` like a real template would. */
const plugin = [
  "import { readFileSync } from 'node:fs';",
  'export default () => ({',
  "  name: 'fake-view',",
  '  setup(build) {',
  '    build.onLoad({ filter: /[.]view$/ }, (args) => ({',
  "      contents: `import { translate } from '../i18n';\nexport default () => translate(${JSON.stringify(readFileSync(args.path, 'utf8').trim())});\n`,",
  "      loader: 'js',",
  '    }));',
  '  },',
  '});',
  '',
].join('\n');

const files: Record<string, string> = {
  'tslaws.json': JSON.stringify({ bundlerPlugins: ['./tools/plugin.mjs'] }),
  'tools/plugin.mjs': plugin,
  'src/globals.d.ts': "declare module '*.view' { const render: () => string; export default render; }\n",
  'src/i18n/index.ts': [
    'export const state = { calls: 0 };',
    'export const translate = (key: string): string => {',
    '  state.calls += 1;',
    '  return `t:${key}`;',
    '};',
    '',
  ].join('\n'),
  'src/components/greeting.view': 'hello',
  'src/components/greeting.ts': [
    '/// <reference path="../globals.d.ts" />',
    "import view from './greeting.view';",
    'export const greeting = (): string => view();',
    '',
  ].join('\n'),
  'src/components/greeting.laws.ts': [
    "import { law } from 'tslaws';",
    "import { state } from '../i18n';",
    "import { greeting } from './greeting';",
    "law('the template renders through the i18n module', () => greeting() === 't:hello');",
    "law('the law and the template share one i18n instance', () => {",
    '  const before = state.calls;',
    '  greeting();',
    '  return state.calls === before + 1;',
    '});',
    '',
  ].join('\n'),
};

function project(name: string): string {
  const dir = join(root, name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

function options(cwd: string, sandbox: boolean): CheckOptions {
  const lawFiles = ['src/components/greeting.laws.ts'];
  const opts: CheckOptions = {
    files: lawFiles,
    cwd,
    runs: 25,
    compiler: 'builtin',
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: true,
    bound: 4,
    proofTimeoutMs: 5000,
    propertyTimeoutMs: 20000,
    sandbox,
  };
  writeLock(opts.lockFile, readManifest('builtin', lawFiles, cwd));
  return opts;
}

const byName = (results: LawResult[], name: string): LawResult => {
  const found = results.find((r) => r.name === name);
  assert.ok(found, `no result for ${name}: ${JSON.stringify(results)}`);
  return found;
};

describe('a plugin-loaded file that imports a compiled .ts module', () => {
  for (const sandbox of [true, false])
    it(`reaches the compiled twin, one instance for the law and the template (sandbox: ${sandbox})`, async () => {
      const cwd = project(sandbox ? 'sandboxed' : 'plain');
      const { results } = await check(options(cwd, sandbox), true);
      for (const name of [
        'the template renders through the i18n module',
        'the law and the template share one i18n instance',
      ])
        assert.equal(byName(results, name).status, 'tested', JSON.stringify(byName(results, name)));
    });
});

// A worker outlives a check, so a law that runs again in it loads its modules again. A file a `bundlerPlugins` hook
// loaded (a template) sits outside the output directory; if it stayed cached it would keep the old copy of the module it
// imports while the law gets a fresh one, and the two would no longer share state.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readManifest } from '../dist/compile.js';
import { check } from '../dist/check.js';
import { writeLock } from '../dist/lock.js';
import type { CheckOptions } from '../dist/types.js';

// One job, so every run of the law lands in the same worker whatever the host or the file's own setting.
process.env.TSLAWS_JOBS = '1';

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-plugin-cache-'));

after(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const files: Record<string, string> = {
  'tslaws.json': JSON.stringify({ bundlerPlugins: ['./tools/plugin.mjs'] }),
  'tools/plugin.mjs': [
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
  ].join('\n'),
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
    "law('the law and the template share one i18n instance', () => {",
    '  const before = state.calls;',
    '  greeting();',
    '  return state.calls === before + 1;',
    '});',
    '',
  ].join('\n'),
};

describe('a law that runs twice in one worker', () => {
  for (const sandbox of [true, false])
    it(`shares one module with a plugin-loaded template on both runs (sandbox: ${sandbox})`, async () => {
      const cwd = join(root, sandbox ? 'sandboxed' : 'plain');
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(dirname(join(cwd, file)), { recursive: true });
        writeFileSync(join(cwd, file), text);
      }
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
      for (const run of [1, 2]) {
        const { results } = await check(opts, true);
        const [result] = results;
        assert.equal(results.length, 1);
        assert.equal(result?.status, 'tested', `run ${run}: ${JSON.stringify(result)}`);
      }
    });
});

// A program prepared for sharing with checker threads (`Program.prepareForSharing`, used by
// `--checkers`) reports the diagnostics of an unshared one. Preparing computes the common source
// directory, which checks that files are under `rootDir` or the config file's directory; as in tsgo,
// that check reports only when options compute the directory while the program is created.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileSources, tempDir } from './temp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const bundledLibs = join(root, 'upstream/typescript-go/internal/bundled/libs');

const out = compileSources('tsc-ts-shared-program-', ['main.ts']);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { createNodeSystem } = await load('drivers/node-system.js');
const { executeCommandLine } = await load('compiler/tsc-cli.js');
const { bindProgram, CheckedProgram } = await load('compiler/program-checker.js');
const { CompileTimes, PlainProgram, getDiagnosticsOfProgram } = await load('compiler/compile-program.js');

// `app/tsconfig.json` includes a file outside its directory, like T3 Code's apps including
// `../../scripts/lib`.
function project(compilerOptions) {
  const dir = tempDir('tsc-ts-shared-program-project-');
  const files = {
    'app/tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, types: [], ...compilerOptions },
      include: ['src', '../shared'],
    }),
    'app/src/main.ts': "import { value } from '../../shared/value';\nexport const doubled = value * 2;\n",
    'shared/value.ts': 'export const value = 1;\n',
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return join(dir, 'app');
}

function diagnosticCodes(dir, prepare) {
  const work = executeCommandLine(createNodeSystem(bundledLibs, ''), ['-p', dir]);
  assert.equal(work.kind, 'compile');
  bindProgram(work.program);
  if (prepare) work.program.prepareForSharing();
  const compiled = new PlainProgram(new CheckedProgram(work.program), new CompileTimes());
  return getDiagnosticsOfProgram(compiled, true).map((d) => d.code);
}

test('preparing a program for sharing does not report files outside the default rootDir', () => {
  const dir = project({});
  assert.deepEqual(diagnosticCodes(dir, false), []);
  assert.deepEqual(diagnosticCodes(dir, true), []);
});

test('a program prepared for sharing still reports files outside an explicit rootDir', () => {
  const dir = project({ rootDir: '.' });
  assert.deepEqual(diagnosticCodes(dir, false), [6059]);
  assert.deepEqual(diagnosticCodes(dir, true), [6059]);
});

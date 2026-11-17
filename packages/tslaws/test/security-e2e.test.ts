// A law file imports tslaws/security and states a CWE law over the user's own function, checked by the real compiler.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check } from '../dist/check.js';
import { readManifest } from '../dist/compile.js';
import { writeLock } from '../dist/lock.js';
import { github, junit } from '../dist/reporters.js';
import type { CheckOptions, LawResult } from '../dist/types.js';

const compiler = process.env.TSC_LAWS_BIN;
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '..', '.tmp-sec-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});

function project(name: string, files: Record<string, string>): CheckOptions {
  const cwd = join(root, name);
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), body);
  }
  // Resolve `tslaws/security` to this checkout's build, not to whichever copy node_modules happens to hold.
  mkdirSync(join(cwd, 'node_modules'), { recursive: true });
  symlinkSync(join(here, '..'), join(cwd, 'node_modules', 'tslaws'), 'junction');
  const options: CheckOptions = {
    files: ['src/f.laws.ts'],
    cwd,
    runs: 100,
    compiler: compiler!,
    lockFile: join(cwd, 'tsc-laws.lock'),
    noProve: true,
    bound: 4,
    proofTimeoutMs: 10000,
  };
  writeLock(options.lockFile, readManifest(compiler!, options.files, cwd));
  return options;
}

function byName(results: LawResult[], name: string): LawResult {
  const found = results.find((r) => r.name === name);
  assert.ok(found, `no result for ${name}: ${JSON.stringify(results)}`);
  return found;
}

const lawFile = (impl: string, body: string): string =>
  [
    "import { pathTraversal } from 'tslaws/security';",
    "import type { PathPayload } from 'tslaws/security';",
    "import { sanitise } from './f';",
    "const traversal = pathTraversal(sanitise, { base: '/srv/files', flavour: 'posix' });",
    body,
    impl,
  ]
    .filter((line) => line !== '')
    .join('\n');

describe('tslaws/security in a law file', { skip: compiler === undefined ? 'set TSC_LAWS_BIN' : false }, () => {
  const stays = 'export law staysInside(p: PathPayload) => traversal.holds(p);\n';

  it('fails a vulnerable sanitiser with the CWE tag in the result and the reports', async () => {
    const opts = project('bad', {
      'src/f.ts': "export function sanitise(p: string): string {\n  return '/srv/files/' + p.replace('../', '');\n}\n",
      'src/f.laws.ts': lawFile('', stays),
    });
    const report = await check(opts, true);
    const result = byName(report.results, 'staysInside');
    assert.equal(result.status, 'failed', JSON.stringify(result));
    assert.match(result.message ?? '', /\[CWE-22\]/);
    assert.match(junit(report), /\[CWE-22\]/);
    assert.match(github(report), /\[CWE-22\]/);
  });

  it('passes a sanitiser that resolves and checks the path', async () => {
    const opts = project('good', {
      'src/f.ts': [
        "import { resolve, sep } from 'node:path/posix';",
        'export function sanitise(p: string): string {',
        "  if (p.includes('\\0')) throw new Error('refused');",
        "  const full = resolve('/srv/files', p.replaceAll('\\\\', '/'));",
        "  const base = resolve('/srv/files');",
        '  if (full !== base && !full.startsWith(base + sep)) throw new Error("outside");',
        '  return full;',
        '}',
        '',
      ].join('\n'),
      'src/f.laws.ts': lawFile('', stays),
    });
    const report = await check(opts, true);
    const result = byName(report.results, 'staysInside');
    assert.equal(result.status, 'tested', JSON.stringify(result));
  });
});

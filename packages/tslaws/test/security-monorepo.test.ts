// `tslaws security deps` at the root of a monorepo: each package checks its own imports with its own config, a nested
// project is left to itself, and nothing here touches the network (--offline, or a fetch that is never called).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDeps } from '../dist/security/deps/run.js';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'bin', 'tslaws.js');
const scratch = mkdtempSync(join(here, '..', '.tmp-secmono-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const lock = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': {},
    'node_modules/lodash': { version: '4.17.20' },
    'node_modules/left-pad': { version: '1.3.0' },
  },
});

function repo(files: Record<string, string | object>): string {
  const root = mkdtempSync(join(scratch, 'r-'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return root;
}

function tslaws(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync('node', [bin, ...args], { cwd, encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

const monorepo = (): string =>
  repo({
    'package-lock.json': lock,
    'tslaws.json': { projects: ['packages/*'] },
    'packages/a/tslaws.json': { cover: ['src/**/*.ts'] },
    'packages/a/src/x.ts': "import _ from 'lodash';\nexport const x = _;\n",
    'packages/b/tslaws.json': { cover: ['src/**/*.ts'], security: { failOn: 'low' } },
    'packages/b/src/y.ts': "import pad from 'left-pad';\nexport const y = pad;\n",
  });

describe('tslaws security deps in a monorepo', () => {
  it('runs in every package under a header, each with the packages it imports', () => {
    const { status, stdout, stderr } = tslaws(monorepo(), 'security', 'deps', '--offline');
    assert.equal(status, 0, stdout + stderr);
    const [a, b] = stdout.split('── packages/b ──');
    assert.match(a!, /── packages\/a ──/);
    assert.match(a!, /lodash@4\.17\.20/);
    assert.doesNotMatch(a!, /left-pad/);
    assert.match(b!, /left-pad@1\.3\.0/);
    assert.doesNotMatch(b!, /lodash/);
    assert.match(stdout, /2 projects, 0 failed/);
  });

  it('keeps each package its own failOn', () => {
    const root = monorepo();
    assert.match(
      tslaws(root, 'security', 'deps', '--offline', '--project', 'packages/b').stdout,
      /none at or above low/,
    );
    assert.match(
      tslaws(root, 'security', 'deps', '--offline', '--project', 'packages/a').stdout,
      /none at or above high/,
    );
  });

  it('prints one JSON object keyed by project with --json', () => {
    const { status, stdout } = tslaws(monorepo(), 'security', 'deps', '--offline', '--json');
    assert.equal(status, 0);
    const report = JSON.parse(stdout) as Record<string, { failOn: string }>;
    assert.deepEqual(Object.keys(report), ['packages/a', 'packages/b']);
    assert.equal(report['packages/b']!.failOn, 'low');
  });

  it('reports a package whose config is broken as failed and goes on with the rest', () => {
    const root = monorepo();
    writeFileSync(join(root, 'packages/a/tslaws.json'), '{"security":{"failOn":"severe"}}');
    const { status, stdout } = tslaws(root, 'security', 'deps', '--offline');
    assert.equal(status, 1);
    assert.match(stdout, /failOn/);
    assert.match(stdout, /left-pad@1\.3\.0/);
  });
});

describe('checkDeps with nested projects', () => {
  it('leaves the files of a nested project to that project and never calls the network', async () => {
    const root = repo({
      'package-lock.json': lock,
      'src/x.ts': "import _ from 'lodash';\nexport const x = _;\n",
      'inner/src/y.ts': "import pad from 'left-pad';\nexport const y = pad;\n",
    });
    const fetch = async (): Promise<never> => {
      throw new Error('network used');
    };
    const report = await checkDeps({ cwd: root, skip: ['inner'], offline: true, noCache: true, fetch });
    assert.deepEqual(
      report.packages.map((p) => p.name),
      ['lodash'],
    );
  });
});

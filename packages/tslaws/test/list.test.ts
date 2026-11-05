// `tslaws list`: laws files with the level they run at and their standing. Reads files and the lock only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listLawFiles, renderList } from '../dist/list.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'tslaws-list-'));
after(() => rmSync(root, { recursive: true, force: true }));

const law = 'export law ok(n: number) { return n === n; }\n';

function project(files: Record<string, string>): string {
  const cwd = mkdtempSync(join(root, 'p-'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), text);
  }
  return cwd;
}

const files = {
  'tslaws.json': JSON.stringify({ laws: ['specs/*.ts'] }),
  'src/a.laws.ts': law,
  'src/helper.ts': "import { mount } from 'tslaws/browser';\nexport const m = mount;\n",
  'src/ui.laws.ts': "import { m } from './helper';\n" + law,
  'src/shop.e2e.laws.ts': "import { open } from 'tslaws/e2e';\n" + law,
  'src/old.proposed.laws.ts': law,
  'specs/custom.ts': law,
  '.tslaws/proposals/p.ts': "import { mount } from 'tslaws/browser';\n" + law,
  'tsc-laws.lock': JSON.stringify({ version: 1, laws: { 'src/a.laws.ts::ok': 'x' }, exempt: [] }),
};

describe('tslaws list', () => {
  it('gives each file its level from its imports and its standing from the lock', () => {
    const listed = listLawFiles(project(files));
    const summary = listed.map(
      (f) => `${f.file} ${f.kind} ${f.status}${f.proposal === undefined ? '' : ` ${f.proposal}`}`,
    );
    assert.deepEqual(summary, [
      'specs/custom.ts node unaccepted',
      'src/a.laws.ts node accepted',
      'src/shop.e2e.laws.ts e2e unaccepted',
      'src/ui.laws.ts browser unaccepted',
      'src/old.proposed.laws.ts node proposed name',
      '.tslaws/proposals/p.ts browser proposed proposals',
    ]);
  });

  it('reports a file that reaches both levels as an error, with its notices', () => {
    const cwd = project({
      'a.laws.ts': "import { open } from 'tslaws/e2e';\nimport { mount } from 'tslaws/browser';\n" + law,
      'b.browser.laws.ts': law,
    });
    const [a, b] = listLawFiles(cwd);
    assert.match(a!.error ?? '', /not both/);
    assert.equal(b!.kind, 'browser');
    assert.match(b!.notices[0] ?? '', /name says browser/);
    assert.match(renderList([a!, b!]), /a\.laws\.ts {2}\(.*not both/);
  });

  it('prints JSON from the command line, and runs nothing', () => {
    const cwd = project(files);
    const run = spawnSync(process.execPath, [join(here, '..', 'bin', 'tslaws.js'), 'list', '--json'], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, TSC_LAWS_BIN: join(cwd, 'no-compiler-needed') },
    });
    assert.equal(run.status, 0, run.stderr);
    const parsed = JSON.parse(run.stdout) as { files: { file: string; kind: string; status: string }[] };
    assert.equal(parsed.files.find((f) => f.file === 'src/ui.laws.ts')?.kind, 'browser');
    const text = spawnSync(process.execPath, [join(here, '..', 'bin', 'tslaws.js'), 'list'], { cwd, encoding: 'utf8' });
    assert.match(text.stdout, /e2e +unaccepted +src\/shop\.e2e\.laws\.ts/);
  });

  it('says so when there are none', () => {
    assert.equal(renderList(listLawFiles(project({ 'x.ts': 'export const a = 1;\n' }))), 'no laws files found\n');
  });
});
